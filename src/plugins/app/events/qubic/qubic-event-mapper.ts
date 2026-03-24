import {
  type QubicStoredEvent,
  type QubicLockEventPayload,
  type QubicOverrideLockEventPayload,
  type QubicUnlockEventPayload,
} from "./schemas/qubic-event.js";
import { nonceToBytes, solanaAddressToBytes, toU64BigInt } from "../../common/bytes.js";
import { qubicAddressToBytes } from "../../common/qubic/encoding.js";

export type QubicLockEvent = {
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  nonce: Uint8Array;
  orderEra: number;
};

export type QubicOverrideLockEvent = {
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  nonce: Uint8Array;
  orderEra: number;
};

export type QubicUnlockEvent = {
  toAddress: Uint8Array;
  amount: bigint;
  nonce: Uint8Array;
};

function mapLockPayload(payload: QubicLockEventPayload): QubicLockEvent {
  return {
    fromAddress: qubicAddressToBytes(payload.fromAddress),
    toAddress: solanaAddressToBytes(payload.toAddress),
    amount: toU64BigInt(payload.amount, "amount"),
    relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
    nonce: nonceToBytes(payload.nonce),
    orderEra: Number(payload.orderEra),
  };
}

function mapOverrideLockPayload(payload: QubicOverrideLockEventPayload): QubicOverrideLockEvent {
  return {
    fromAddress: qubicAddressToBytes(payload.fromAddress),
    toAddress: solanaAddressToBytes(payload.toAddress),
    amount: toU64BigInt(payload.amount, "amount"),
    relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
    nonce: nonceToBytes(payload.nonce),
    orderEra: Number(payload.orderEra),
  };
}

function mapUnlockPayload(payload: QubicUnlockEventPayload): QubicUnlockEvent {
  return {
    toAddress: solanaAddressToBytes(payload.toAddress),
    amount: toU64BigInt(payload.amount, "amount"),
    nonce: nonceToBytes(payload.nonce),
  };
}

export function mapStoredEventToQubicPayload(event: QubicStoredEvent) {
  if (event.type === "lock") {
    return {
      type: "lock" as const,
      event: mapLockPayload(event.payload as QubicLockEventPayload),
    };
  }
  if (event.type === "override-lock") {
    return {
      type: "override-lock" as const,
      event: mapOverrideLockPayload(event.payload as QubicOverrideLockEventPayload),
    };
  }
  return {
    type: "unlock" as const,
    event: mapUnlockPayload(event.payload as QubicUnlockEventPayload),
  };
}
