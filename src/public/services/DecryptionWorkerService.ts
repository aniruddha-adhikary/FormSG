import fetchStream from 'fetch-readablestream'
import { range } from 'lodash'

import { ReaderResult } from 'src/types/utils'

import CsvMHGenerator from '../helpers/CsvMergedHeadersGenerator'
import DecryptionWorker from '../modules/forms/helpers/decryption.worker.ts'
import { ndjsonStream } from '../modules/forms/helpers/ndjsonStream'

import * as AdminSubmissionsService from './AdminSubmissionsService'

/**
 * Structure
 *
 * We should have a base worker service file
 * this file only handles initialization of workers
 * and provides an easy api to cancel
 *
 * next, layer over this with actual business logic workers
 * these worker handlers communicate with actual web workers through APIs provided by ^
 *
 * then, let a service call the respective business logic workers
 */

interface WorkerConfig {
  onmessage: (e: MessageEvent) => void
  onerror: (e: ErrorEvent) => void
}

// Helper function to kill an array of EncryptionWorkers
function killWorkers(pool: Worker[]) {
  pool.forEach((worker) => worker.terminate())
}

const initializeWorkers = (numWorkers: number, config?: WorkerConfig) => {
  const downloadAbortController: AbortController = new AbortController()
  const workerPool: Worker[] = range(numWorkers).map(() => {
    const worker = new DecryptionWorker()
    // NOTE: Need to set as null because undefined is not accepted
    worker.onerror = config?.onerror ?? null
    worker.onmessage = config?.onmessage ?? null
    return worker
  })

  const cancelDownload = () => {
    downloadAbortController.abort()
    killWorkers(workerPool)
  }

  return {
    workers: workerPool,
    cancel: cancelDownload,
    isCancelled: downloadAbortController.signal,
  }
}

/**
 * TODO: change to shouldDownloadAttachments for future readers...
 * Triggers a download of file responses when called
 * @param {String} params.formId ID of the form
 * @param {String} params.formTitle The title of the form
 * @param  {String} params.startDate? The specific start date to filter for file responses in YYYY-MM-DD
 * @param  {String} params.endDate? The specific end date to filter for file responses in YYYY-MM-DD
 * @param {Boolean} downloadAttachments Whether to download attachments as ZIP files in addition to responses as CSV
 * @param {String} secretKey An instance of EncryptionKey for decrypting the submission
 * @returns {Promise} Empty Promise object for chaining
 */
const downloadEncryptedResponses = (params, downloadAttachments, secretKey) => {
  let attachmentErrorCount = 0
  let errorCount = 0
  let unverifiedCount = 0
  let receivedRecordCount = 0

  // Create a pool of decryption workers
  // If we are downloading attachments, we restrict the number of threads
  // to one to limit resource usage on the client's browser.
  const numWorkers = downloadAttachments
    ? 1
    : window.navigator.hardwareConcurrency || 4

  const { workers: workerPool, cancel, isCancelled } = initializeWorkers(
    numWorkers,
    {
      onmessage: (event) => {
        const { data } = event
        const { csvRecord } = data

        // Error signalling from worker thread
        if (csvRecord.status === 'ATTACHMENT_ERROR') {
          attachmentErrorCount++
          errorCount++
        } else if (csvRecord.status === 'ERROR') {
          errorCount++
        } else if (csvRecord.status === 'UNVERIFIED') {
          unverifiedCount++
        }

        // Checking for submission data
        if (csvRecord.submissionData) {
          // accumulate dataset if it exists, since we may have status columns available
          experimentalCsvGenerator.addRecord(csvRecord.submissionData)
        }

        // Download iff attachments and blob exists
        if (downloadAttachments && csvRecord.downloadBlob) {
          triggerFileDownload(
            csvRecord.downloadBlob,
            'RefNo ' + csvRecord.id + '.zip',
          )
        }
      },

      // When worker fails to decrypt a message
      onerror: (error) => {
        errorCount++
        console.error('EncryptionWorker Error', error)
      },
    },
  )

  const { formId, startDate, endDate } = params

  return AdminSubmissionsService.countFormSubmissions({
    formId,
    startDate,
    endDate,
  }).then((expectedNumResponses) => {
    return new Promise(function (resolve, reject) {
      // No responses expected
      if (expectedNumResponses === 0) {
        return resolve({
          expectedCount: 0,
          successCount: 0,
          errorCount: 0,
        })
      }

      const resUrl = generateDownloadUrl(params, downloadAttachments)
      let experimentalCsvGenerator = new CsvMHGenerator(
        expectedNumResponses,
        NUM_OF_METADATA_ROWS,
      )

      // Trigger analytics here before starting decryption worker.
      GTag.downloadResponseStart(params, expectedNumResponses, numWorkers)

      // Let the caller care about Gtags and perf
      // What a decryption worker should do is to decrypt then return ONLY

      fetchStream(resUrl, { signal: isCancelled })
        .then((response: { body: ReadableStream<Uint8Array> | null }) =>
          ndjsonStream(response.body),
        )
        .catch((err) => {
          // some error here because couldn't initialize the stream
          // No start time, means did not even start http request.
          GTag.downloadNetworkFailure(params, err)
        })
        .then((stream) => {
          const downloadStartTime = performance.now()
          const reader = stream.getReader()

          const read = (result: ReaderResult<string>) => {
            if (result.done) return
            try {
              // round-robin scheduling
              workerPool[receivedRecordCount % numWorkers].postMessage({
                line: result.value,
                secretKey,
                downloadAttachments,
              })
              receivedRecordCount++
            } catch (error) {
              console.error('Error parsing JSON', error)
            }
            reader.read().then(read) // recurse through the stream
          }

          reader
            .read()
            .then(read)
            .catch((err) => {
              const downloadFailedTime = performance.now()
              const timeDifference = downloadFailedTime - downloadStartTime
              // Google analytics tracking for failure.
              GTag.downloadResponseFailure(
                params,
                numWorkers,
                expectedNumResponses,
                timeDifference,
                err,
              )

              // NOTE: This should be shifted to a finally block
              console.error(
                'Failed to download data, is there a network issue?',
                err,
              )
              killWorkers(workerPool)
              reject(err)
            })
            .finally(() => {
              function checkComplete() {
                // If all the records could not be decrypted
                if (errorCount + unverifiedCount === expectedNumResponses) {
                  const failureEndTime = performance.now()
                  const timeDifference = failureEndTime - downloadStartTime
                  // Google analytics tracking for partial decrypt
                  // failure.
                  GTag.partialDecryptionFailure(
                    params,
                    numWorkers,
                    experimentalCsvGenerator.length(),
                    errorCount,
                    attachmentErrorCount,
                    timeDifference,
                  )
                  killWorkers(workerPool)
                  reject(
                    new Error(
                      JSON.stringify({
                        expectedCount: expectedNumResponses,
                        successCount: experimentalCsvGenerator.length(),
                        errorCount,
                        unverifiedCount,
                      }),
                    ),
                  )
                } else if (
                  // All results have been decrypted
                  experimentalCsvGenerator.length() +
                    errorCount +
                    unverifiedCount >=
                  expectedNumResponses
                ) {
                  killWorkers(workerPool)
                  // Generate first three rows of meta-data before download
                  experimentalCsvGenerator.addMetaDataFromSubmission(
                    errorCount,
                    unverifiedCount,
                  )
                  experimentalCsvGenerator.downloadCsv(
                    `${params.formTitle}-${params.formId}.csv`,
                  )

                  const downloadEndTime = performance.now()
                  const timeDifference = downloadEndTime - downloadStartTime

                  // Google analytics tracking for success.
                  GTag.downloadResponseSuccess(
                    params,
                    numWorkers,
                    experimentalCsvGenerator.length(),
                    timeDifference,
                  )

                  resolve({
                    expectedCount: expectedNumResponses,
                    successCount: experimentalCsvGenerator.length(),
                    errorCount,
                    unverifiedCount,
                  })
                  // Kill class instance and reclaim the memory.
                  experimentalCsvGenerator = null
                } else {
                  $timeout(checkComplete, 100)
                }
              }

              checkComplete()
            })
        })
    })
  })
}
