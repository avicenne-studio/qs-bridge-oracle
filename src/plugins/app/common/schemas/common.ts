import { Type } from '@sinclair/typebox'

export const StringSchema = Type.String({
  minLength: 1,
  maxLength: 255
})

export const DateTimeSchema = Type.String({ format: 'date-time' })

export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export const IdSchema = Type.String({ pattern: UUID_PATTERN })

export const SIGNATURE_MAX_LENGTH = 256

export const SignatureSchema = Type.String({
  minLength: 1,
  maxLength: SIGNATURE_MAX_LENGTH
})
