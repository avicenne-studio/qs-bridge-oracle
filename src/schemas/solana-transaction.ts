import { Static, Type } from '@sinclair/typebox'
import { StringSchema } from './common.js'

export const SolanaInstructionSchema = Type.Object({
  programId: StringSchema,                   
  accounts: Type.Array(StringSchema),        
  data: StringSchema                          
})

export const SolanaTransactionSchema = Type.Object({
  recentBlockhash: StringSchema,             
  feePayer: StringSchema,                    
  instructions: Type.Array(SolanaInstructionSchema),
  signatures: Type.Array(StringSchema)       
})

export interface SolanaTransaction extends Static<typeof SolanaTransactionSchema> {}
export interface SolanaInstruction extends Static<typeof SolanaInstructionSchema> {}