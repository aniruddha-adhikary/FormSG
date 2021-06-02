/* eslint-env worker */
import 'core-js/stable'
import 'regenerator-runtime/runtime'

import { FormField as VerifiedFormField } from '@opengovsg/formsg-sdk/dist/types'
import { flatMapDeep, isEmpty, join, omit } from 'lodash'
import { errAsync, ok, okAsync, Result, ResultAsync } from 'neverthrow'
import { default as PQueue } from 'p-queue'

import {
  BasicField,
  IResponseWorker,
  WorkerError,
  WorkerErrorStates,
  WorkerState,
  WorkerSuccessStates,
} from '../../types'
import { processDecryptedContent } from '../modules/forms/helpers/process-decrypted-content'
import { downloadAndDecryptAttachmentsAsZip } from '../services/AdminSubmissionsService'
import { FormSgSdk } from '../services/FormSgSdkService'

type TResponse = {
  csvRecord: CsvRecord | WorkerError
}

// Casted as any to allow TS to infer typings for self.
// This is required because otherwise, TS infers self as being of type Window.
// However, because workers run in a separate (and more restricted) context, this is not true.
// An important difference is in the postMessage API, which differs between Worker/Window
// Refer here: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const worker: IResponseWorker<TResponse> = self as any

// NOTE: These types are meant only for internal consumption and are not exposed.
// Because postMessage uses a structured clone to return data back to the main thread,
// the types on the main thread can differ.
// Hence, the calling API should declare its own types rather than relying on definitions here.
// Refer here for postMessage information: https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage
type LineData = {
  line: string
  secretKey: string
  downloadAttachments?: boolean
}

type EncryptedSubmission = {
  encryptedContent: string
  verifiedContent: string
  created: string
  _id: string
  attachmentMetadata: Record<string, string>
}

type SubmissionMeta = Omit<
  EncryptedSubmission,
  'encryptedContent' | 'verifiedContent'
>

type AttachmentDownloadInfo = {
  url: string
  filename: string
}

type VerifiedFormFieldWithQuestionNumber = VerifiedFormField & {
  // NOTE: This is undefined when fieldType === section
  questionNumber?: number
}

type SubmissionData = {
  created: string
  submissionId: string
  record: VerifiedFormField[]
}

// Represents a csv record decrypted by a decryption worker
type CsvRecord = {
  status: WorkerSuccessStates.Success
  submissionData: SubmissionData
  id: string
  downloadBlob?: Blob
}

/**
 * This function generates the metadata for the downloaded records and acts as a sentinel value
 * This should be called and inserted at the front of every decrypted submission
 */
const generateDownloadMeta = (
  statusMessage: WorkerState,
): VerifiedFormFieldWithQuestionNumber => ({
  _id: '000000000000000000000000',
  fieldType: 'textfield',
  question: 'Download Status',
  answer: statusMessage,
  questionNumber: 1000000,
})

const generateCsvRecord = (
  meta: SubmissionMeta,
  decryptedSubmission: VerifiedFormField[],
  downloadBlob?: Blob,
): CsvRecord => {
  const downloadStatus = generateDownloadMeta(WorkerSuccessStates.Success)
  const output = [downloadStatus, ...decryptedSubmission]

  return {
    status: WorkerSuccessStates.Success,
    submissionData: {
      created: meta.created,
      submissionId: meta._id,
      record: output,
    },
    downloadBlob,
    id: meta._id,
  }
}

/**
 * Verifies that the signatures for every field that has a corresponding signature are valid.
 * If any one of them is invalid, append NOT VERIFIED to that record.
 * We do not retrieve the form to check if fields must be verifiable. Thus if a field is verifiable but does not have a signature,
 * we would not verify it here.
 * @param decryptedSubmission Array of JSON objects representing questions and answers
 * @param created Database timestamp of submission
 * @returns true if signature is valid, false otherwise
 */
function verifySignature(
  decryptedSubmission: VerifiedFormField[],
  created: string,
): boolean {
  const signatureFields = decryptedSubmission.filter((field) => field.signature)
  if (signatureFields.length === 0) return true
  const verified = signatureFields.map((field) => {
    const { signature: signatureString, _id: fieldId, answer } = field

    if (!signatureString || !answer) return false

    try {
      return FormSgSdk.verification.authenticate({
        signatureString,
        submissionCreatedAt: Date.parse(created),
        fieldId,
        answer,
      })
    } catch {
      return false
    }
  })
  return verified.every((v) => v)
}

const parseAsEncryptedSubmission = (line: string): EncryptedSubmission =>
  JSON.parse(line)

const safeJsonParse = (line: string) =>
  Result.fromThrowable(
    () => parseAsEncryptedSubmission(line),
    (): WorkerError => ({
      status: WorkerErrorStates.AttachmentDownloadError,
    }),
  )()

const checkInitializationState = Result.fromThrowable(
  () => {
    if (!FormSgSdk) {
      throw new Error()
    }
    return true
  },
  (): WorkerError => ({
    status: WorkerErrorStates.InitializationError,
    message:
      'An init message containing the node environment must first be passed in before any other action',
  }),
)

// Flattens an array into a flat string separated by ,
const generateFieldName = (fieldAnswer?: string[] | string[][]): string => {
  const fieldAnswers = flatMapDeep(fieldAnswer)

  if (isEmpty(fieldAnswers)) {
    return ''
  }

  return join(fieldAnswers)
}

const generateAttachmentDownloadUrls = (
  decryptedSubmission: VerifiedFormField[],
  attachmentMetadata: Record<string, string>,
): Map<number, AttachmentDownloadInfo> => {
  const { map: attachmentDownloadUrls } = decryptedSubmission.reduce(
    ({ map, count }, field) => {
      if (field.fieldType !== BasicField.Section) {
        count++
      }
      map.set(count, {
        url: attachmentMetadata[field._id],
        filename: field.answer || generateFieldName(field.answerArray),
      })

      return { map, count }
    },
    { map: new Map(), count: 0 },
  )

  return attachmentDownloadUrls
}

const downloadAttachments = (
  secretKey: string,
  attachmentDownloadUrls: Map<number, AttachmentDownloadInfo>,
): ResultAsync<Blob, WorkerError> => {
  const queue = new PQueue({ concurrency: 1 })
  const initializeDownloads = async () => {
    return queue.add(() =>
      downloadAndDecryptAttachmentsAsZip(attachmentDownloadUrls, secretKey),
    )
  }

  return ResultAsync.fromPromise(
    initializeDownloads(),
    (): WorkerError => {
      return {
        status: WorkerErrorStates.AttachmentDownloadError,
      }
    },
  )
}

const decryptIntoResult = (
  secretKey: string,
  encryptedContent: string,
  verifiedContent?: string,
) =>
  Result.fromThrowable(
    () => {
      // NOTE: The decrypt function uses null to signal errors
      // Because processing is dependent on the fact that decryption is successful,
      // Short-circuit by throwing an error
      const decryptedContent = FormSgSdk.crypto.decrypt(secretKey, {
        encryptedContent,
        verifiedContent,
        // TODO(#2029): Use submission's own version number when server returns this.
        version: 1,
      })
      // NOTE: No custom error because signalling is done through WorkerError type
      if (!decryptedContent) throw new Error()
      return decryptedContent
    },
    (): WorkerError => ({
      status: WorkerErrorStates.DecryptionError,
      message: 'Decryption of the given content failed.',
    }),
  )()

/**
 * Decrypts given data into a {@link CsvRecord} and posts the result back to the
 * main thread.
 * @param data The data to decrypt into a csvRecord.
 */
const decryptIntoCsv = (data: LineData): ResultAsync<void, never> => {
  const {
    line,
    secretKey,
    downloadAttachments: shouldDownloadAttachments,
  } = data

  return (
    // Step 1: Check if the formsgSdk is initialised
    checkInitializationState()
      // Step 2: Attempt to parse the line as JSON
      .andThen(() => safeJsonParse(line))
      // Step 3: Decrypt the submission
      .andThen((encryptedSubmission) => {
        const { encryptedContent, verifiedContent } = encryptedSubmission
        return decryptIntoResult(
          secretKey,
          encryptedContent,
          verifiedContent,
        ).map((decryptedContent) => {
          const submissionMeta = omit(encryptedSubmission, [
            'encryptedContent',
            'verifiedContent',
          ])
          return { meta: submissionMeta, decrypted: decryptedContent }
        })
      })
      .asyncAndThen<CsvRecord, WorkerError>(({ decrypted, meta }) => {
        const decryptedSubmission = processDecryptedContent(decrypted)
        const isSignatureVerified = verifySignature(
          decryptedSubmission,
          meta.created,
        )

        // Step 4.1: Check if signatures are verified and short-circuit if not
        if (!isSignatureVerified) {
          return errAsync({
            status: WorkerErrorStates.UnverifiedSignatureError,
          })
        }

        // Step 4.2: Determine if we should generate attachments
        if (!shouldDownloadAttachments) {
          return okAsync(generateCsvRecord(meta, decryptedSubmission))
        }

        // Step 4.3: Generate and attempt to download the attachments
        const downloadUrlRecords = generateAttachmentDownloadUrls(
          decryptedSubmission,
          meta.attachmentMetadata,
        )

        return downloadAttachments(
          secretKey,
          downloadUrlRecords,
        ).map((downloadBlob) =>
          generateCsvRecord(meta, decryptedSubmission, downloadBlob),
        )
      })
      // Step 5: postMessage back to main thread with accumulated data
      .map((csvRecord) => worker.postMessage({ csvRecord }))
      .orElse((error) => {
        return ok(worker.postMessage({ csvRecord: error }))
      })
  )
}

worker.addEventListener('message', ({ data }) => {
  if (data) {
    return decryptIntoCsv(data)
  }
})

export default worker
