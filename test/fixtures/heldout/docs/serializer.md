# Message serialization

`serializeMessage` converts a message into JSON with its text and ISO timestamp.
`deserializeMessage` restores the timestamp as a Date object.

## Round trips

Message text must survive serialization and deserialization unchanged.
