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

function requireAdmin(

  req,
  res,
  next

){

  if(

    req.session?.admin

  ){

    return next();

  }

  return res
    .status(401)
    .json({

      success:false,

      message:
        "Unauthorized"

    });

}

// ====================
// GET ALL MESSAGES
// ====================

router.get(

  "/messages",

  requireAdmin,

  (req,res)=>{

    const messages =
      loadMessages();

    res.json(
      messages
    );

  }

);

// ====================
// CLEAR CHAT
// ====================

router.post(

  "/clear-chat",

  requireAdmin,

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

// ====================
// GET USERS
// ====================

router.get(

  "/users",

  requireAdmin,

  (req,res)=>{

    const messages =
      loadMessages();

    const uniqueUsers =

      [...new Set(

        messages.map(
          msg=>
            msg.userId
        )

      )];

    res.json(
      uniqueUsers
    );

  }

);

// ====================
// MARK READ
// ====================

router.post(

  "/mark-read",

  requireAdmin,

  (req,res)=>{

    const {
      userId
    } = req.body;

    const messages =
      loadMessages();

    messages.forEach(

      (msg)=>{

        if(

          msg.userId
          ===
          userId

          &&

          msg.sender
          ===
          "user"

        ){

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