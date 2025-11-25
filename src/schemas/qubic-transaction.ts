import { Static, Type } from '@sinclair/typebox'
import { StringSchema } from './common.js'

export const QubicTransactionSchema = Type.Object({
  sender: StringSchema,                     
  recipient: StringSchema,                  
  amount: Type.Number(),                    
  tick: Type.Number(),                      
  nonce: Type.Number(),                     
  signature: StringSchema                    
})

export interface QubicTransaction extends Static<typeof QubicTransactionSchema> {}
