import { Type } from '@sinclair/typebox'

export const StringSchema = Type.String({
  minLength: 1,
  maxLength: 255
})

export const DateTimeSchema = Type.String({ format: 'date-time' })

export const IdSchema = Type.Integer({ minimum: 1 })

export const SIGNATURE_MAX_LENGTH = 256

export const SignatureSchema = Type.String({
  minLength: 1,
  maxLength: SIGNATURE_MAX_LENGTH
})
