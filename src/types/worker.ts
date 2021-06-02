export type WorkerState = WorkerSuccessStates | WorkerErrorStates
export const enum WorkerSuccessStates {
  Success = 'Success',
}

export const enum WorkerErrorStates {
  AttachmentDownloadError = 'Attachment Download Error',
  UnverifiedSignatureError = 'Unverified Signature Error',
  ParsingError = 'Parsing Error',
  DecryptionError = 'Decryption Error',
  InitializationError = 'Initialization Error',
}

export interface IResponseWorker<TResponse> extends Worker {
  postMessage: (message: TResponse) => void
}

export interface WorkerError {
  status: WorkerErrorStates
  message?: string
}
