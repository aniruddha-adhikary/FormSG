import { chain, left, right } from 'fp-ts/lib/Either'
import { flow } from 'fp-ts/lib/function'
import isEmail from 'validator/lib/isEmail'

import {
  IEmailFieldSchema,
  OmitUnusedValidatorProps,
} from '../../../../types/field'
import { ResponseValidator } from '../../../../types/field/utils/validation'
import { ProcessedSingleAnswerResponse } from '../../../modules/submission/submission.types'

import { makeSignatureValidator, notEmptySingleAnswerResponse } from './common'

type EmailValidator = ResponseValidator<ProcessedSingleAnswerResponse>
type EmailValidatorConstructor = (
  emailField: OmitUnusedValidatorProps<IEmailFieldSchema>,
) => EmailValidator

/**
 * Returns a validator to check if email format is correct.
 */
const emailFormatValidator: EmailValidator = (response) => {
  const { answer } = response
  return isEmail(answer.trim())
    ? right(response)
    : left(`EmailValidator:\t answer is not a valid email`)
}

/**
 * Returns a validation function
 * to check if email domain is valid.
 */
const makeEmailDomainValidator: EmailValidatorConstructor =
  (emailField) => (response) => {
    const { hasAllowedEmailDomains, allowedEmailDomains } = emailField
    const { answer } = response
    const emailAddress = String(answer).trim()
    if (!(hasAllowedEmailDomains && allowedEmailDomains.length))
      return right(response)
    const emailDomain = ('@' + emailAddress.split('@').pop()).toLowerCase()
    const domainMatches = (domainPattern: string) => {
      if (domainPattern.startsWith('*.')) {
        const domainRegexPattern =
          domainPattern.replace(/\*/g, '[a-z0-9-]+') + '$'
        const domainRegex = new RegExp(domainRegexPattern, 'i')
        return domainRegex.test(emailDomain)
      }
      return domainPattern.toLowerCase() === emailDomain
    }

    return allowedEmailDomains.some(domainMatches)
      ? right(response)
      : left(`EmailValidator:\t answer is not a valid email domain`)
  }

/**
 * Returns a validation function for a email field when called.
 */
export const constructEmailValidator: EmailValidatorConstructor = (
  emailField,
) =>
  flow(
    notEmptySingleAnswerResponse,
    chain(emailFormatValidator),
    chain(makeSignatureValidator(emailField)),
    chain(makeEmailDomainValidator(emailField)),
  )
