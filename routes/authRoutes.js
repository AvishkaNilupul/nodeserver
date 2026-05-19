const express = require("express");

const router = express.Router();

const config =
  require("../config/config");

router.post(
  "/admin-login",
  (req, res) => {

    const {
      password
    } = req.body;

    if (

      password ===
      config.ADMIN_PANEL_PASSWORD

    ) {

      return res.json({

        success:true

      });

    }

    return res.json({

      success:false

    });

  }
);

module.exports =
  router;