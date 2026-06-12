const fs = require("fs");
const path = require("path");

const messagesFile =
  path.join(
    __dirname,
    "../messages.json"
  );

// create file

if (
  !fs.existsSync(
    messagesFile
  )
) {

  fs.writeFileSync(
    messagesFile,
    "[]"
  );

}

// =========================
// Load
// =========================

function loadMessages() {

  try {

    const data =
      fs.readFileSync(
        messagesFile,
        "utf8"
      );

    return JSON.parse(
      data
    );

  }

  catch {

    return [];

  }

}

// =========================
// Save
// =========================

function saveMessages(
  messages
) {

  fs.writeFileSync(

    messagesFile,

    JSON.stringify(
      messages,
      null,
      2
    )

  );

}

// =========================
// Add
// =========================

function addMessage(

  userId,
  sellerId,
  sender,
  message

) {

  const messages =
    loadMessages();

messages.push({

  userId,

  sellerId,

  sender,

  message,

    timestamp:
      Date.now(),

    readByAdmin:
      sender === "admin",

    seen:
      false

  });

  saveMessages(
    messages
  );

}
module.exports = {

  loadMessages,

  saveMessages,

  addMessage

};