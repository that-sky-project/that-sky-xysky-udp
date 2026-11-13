import { createRoomId } from '../domain/RoomId.js'

// Runtime identity is deliberately mutable; deployment configuration is not.
export class RoomIdentity {
  constructor () {
    this.id = createRoomId()
  }
}
