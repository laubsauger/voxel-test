// Type surface for server/rooms.mjs (consumed by TS tests).

export declare const MAX_ROOM_SIZE: number
export declare const CODE_LENGTH: number

export interface Outbound {
  to: number
  msg: { t: string; [key: string]: unknown }
}

export declare function makeCodeGen(random?: () => number, length?: number): () => string

export declare class RoomManager {
  constructor(codeGen?: () => string)
  connect(id: number): Outbound[]
  handleMessage(id: number, msg: unknown): Outbound[]
  disconnect(id: number): Outbound[]
}
