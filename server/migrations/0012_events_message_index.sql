-- Lets message deletion find (and remove) the event copies of a message body.
CREATE INDEX events_message_new_id ON events (((payload -> 'message' ->> 'id')::bigint))
    WHERE kind = 'message_new';
CREATE INDEX events_reactions_id ON events (((payload ->> 'id')::bigint))
    WHERE kind = 'reactions';
