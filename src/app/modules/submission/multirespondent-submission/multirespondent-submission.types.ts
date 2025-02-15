import { ParsedClearFormFieldResponsesV3 } from 'src/types/api'

import {
  SubmissionErrorDto,
  SubmissionResponseDto,
} from '../../../../../shared/types'
import {
  MultirespondentFormCompleteDto,
  MultirespondentFormLoadedDto,
  ParsedMultirespondentSubmissionBody,
} from '../../../../types/api/multirespondent_submission'
import { ControllerHandler } from '../../core/core.types'

export type CreateFormsgAndRetrieveFormMiddlewareHandlerType =
  ControllerHandler<
    { formId: string },
    SubmissionResponseDto | SubmissionErrorDto,
    ParsedMultirespondentSubmissionBody,
    { captchaResponse?: unknown; captchaType?: unknown }
  >

export type CreateFormsgAndRetrieveFormMiddlewareHandlerRequest =
  Parameters<CreateFormsgAndRetrieveFormMiddlewareHandlerType>[0] & {
    formsg?: MultirespondentFormLoadedDto
  }

export type MultirespondentSubmissionMiddlewareHandlerType = ControllerHandler<
  { formId: string },
  SubmissionResponseDto | SubmissionErrorDto,
  ParsedMultirespondentSubmissionBody,
  { captchaResponse?: unknown; captchaType?: unknown }
>

export type MultirespondentSubmissionMiddlewareHandlerRequest =
  Parameters<MultirespondentSubmissionMiddlewareHandlerType>[0] & {
    formsg: MultirespondentFormCompleteDto
  }

export type ProcessedMultirespondentSubmissionHandlerType = ControllerHandler<
  { formId: string; submissionId?: string },
  SubmissionResponseDto | SubmissionErrorDto,
  Omit<ParsedMultirespondentSubmissionBody, 'responses'> & {
    responses: ParsedClearFormFieldResponsesV3
  },
  { captchaResponse?: unknown; captchaType?: unknown }
>

export type ProcessedMultirespondentSubmissionHandlerRequest =
  Parameters<ProcessedMultirespondentSubmissionHandlerType>[0] & {
    formsg: MultirespondentFormCompleteDto
  }

export type SubmitMultirespondentFormHandlerType = ControllerHandler<
  { formId: string },
  SubmissionResponseDto | SubmissionErrorDto
>

export type SubmitMultirespondentFormHandlerRequest =
  Parameters<SubmitMultirespondentFormHandlerType>[0] & {
    formsg: MultirespondentFormCompleteDto
  }

export type UpdateMultirespondentSubmissionHandlerType = ControllerHandler<
  { formId: string; submissionId: string },
  SubmissionResponseDto | SubmissionErrorDto
>

export type UpdateMultirespondentSubmissionHandlerRequest =
  Parameters<UpdateMultirespondentSubmissionHandlerType>[0] & {
    formsg: MultirespondentFormCompleteDto
  }
