const express =
  require("express");

const router =
  express.Router();

const {

  loadMessages,
  saveMessages

} = require(
  "../utils/messages"
);

router.get(
  "/messages",
  (req,res)=>{

    const messages =
      loadMessages();

    res.json(
      messages
    );

  }
);

router.post(
  "/clear-chat",
  (req,res)=>{

    const {
      userId
    } = req.body;

    let messages =
      loadMessages();

    messages =
      messages.filter(

        msg=>

          msg.userId
          !==
          userId

      );

    saveMessages(
      messages
    );

    res.json({

      success:true

    });

  }
);

router.get(
  "/users",
  (req,res)=>{

    const messages =
      loadMessages();

    const uniqueUsers =

      [...new Set(

        messages.map(
          msg =>
            msg.userId
        )

      )];

    res.json(
      uniqueUsers
    );

  }
);

router.post(
  "/mark-read",
  (req,res)=>{

    const {
      userId
    } = req.body;

    const messages =
      loadMessages();

    messages.forEach(
      (msg)=>{

        if (

          msg.userId
          ===
          userId

          &&

          msg.sender
          ===
          "user"

        ) {

          msg.readByAdmin =
            true;

        }

      }
    );

    saveMessages(
      messages
    );

    res.json({

      success:true

    });

  }
);

module.exports =
  router;