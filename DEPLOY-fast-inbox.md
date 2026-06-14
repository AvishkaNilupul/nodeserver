# Faster inbox + old-chat reply fix (combined)

This supersedes the previous "admin-oldchat-fix" zip. Drop in these 4 files and
restart. NO npm install, NO DB changes.

## What was slow
Both the inbox list AND opening a chat downloaded the ENTIRE message history
every time (one big /messages call), then filtered it in the browser. As the
history grows this got slower and slower (e.g. ~2 MB transferred per load with
~9k messages in local testing). Every incoming message also re-downloaded it.

## What changed
- New GET /conversations: returns one row per buyer (last message + unread
  count), computed in MongoDB. The inbox list now loads this small payload
  (~34 KB vs ~2 MB in testing) and no longer grows with total history.
- New GET /messages/:userId: the chat view loads only the selected
  conversation (~7 KB) instead of everything.
- admin.html updated to use these two endpoints.
- Also includes the old-chat reply fix: an admin can reply to a buyer if a live
  order exists OR a conversation already exists (so old chats are replyable).

## Files (4)
- routes/chatRoutes.js   (adds /conversations and /messages/:userId)
- utils/messages.js      (getSellerConversations + conversationExists)
- public/admin.html      (inbox uses the new endpoints)
- socket/chatSocket.js   (old-chat reply auth + session re-check)

## Deploy
    cd /var/www/redeemer/nodeserver
    # replace the 4 files (keep paths)
    pm2 restart redeemer

The old /messages and /users endpoints still exist, so nothing else breaks.
