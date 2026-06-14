# Fix: admin can't reply to OLD chats

## Cause
Replying required a *live* order matching the seller (the gamertag had to map to
an existing order tagged with that seller's id). Older conversations whose order
was already used up / removed / created before the multi-seller tagging had no
matching order, so the server silently dropped the reply.

## Fix
An admin can now reply to a buyer if EITHER:
- there is a live order tagged with their seller id (as before), OR
- a conversation already exists between that seller and the buyer.

In short: if the chat shows in your inbox, you can reply to it. Seller isolation
is unchanged — you still can't message someone who is neither your buyer nor in
your existing conversations (verified).

## Files in this zip (only 2 changed — NO npm install needed)
- socket/chatSocket.js   (relaxed the reply auth; also has the session re-check from the previous fix)
- utils/messages.js      (adds conversationExists helper)

## Deploy
    cd /var/www/redeemer/nodeserver
    # replace these two files (keep paths)
    pm2 restart redeemer

No dependency or DB changes. Existing chats become replyable immediately.
