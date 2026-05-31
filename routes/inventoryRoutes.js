const express =
  require("express");

const router =
  express.Router();

const {

  loadInventory,
  saveInventory

} = require(
  "../utils/inventory"
);

// ====================
// GET ALL
// ====================

router.get(

  "/inventory/list",

  (req,res)=>{

    res.json(

      loadInventory()

    );

  }

);

// ====================
// ADD ACCOUNT
// ====================

router.post(

  "/inventory/add",

  (req,res)=>{

    const {

      category,
      username,
      password

    } = req.body;

    const inventory =

      loadInventory();

    inventory.push({

      id:

        Date.now()
        .toString(),

      category,

      username,

      password,

      used:false,

      usedAt:null,

      createdAt:
        Date.now()

    });

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);

// ====================
// MARK USED
// ====================

router.post(

  "/inventory/mark-used/:id",

  (req,res)=>{

    const inventory =
      loadInventory();

    const item =

      inventory.find(

        i=>

          i.id
          ===
          req.params.id

      );

    if(

      !item

    ){

      return res
        .status(404)
        .json({

          success:false

        });

    }

    item.used =
      true;

    item.usedAt =
      Date.now();

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);

// ====================
// MARK UNUSED
// ====================

router.post(

  "/inventory/mark-unused/:id",

  (req,res)=>{

    const inventory =
      loadInventory();

    const item =

      inventory.find(

        i=>

          i.id
          ===
          req.params.id

      );

    if(

      !item

    ){

      return res
        .status(404)
        .json({

          success:false

        });

    }

    item.used =
      false;

    item.usedAt =
      null;

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);

// ====================
// DELETE ACCOUNT
// ====================

router.delete(

  "/inventory/delete/:id",

  (req,res)=>{

    let inventory =
      loadInventory();

    inventory =

      inventory.filter(

        item=>

          item.id
          !==
          req.params.id

      );

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);

module.exports =
  router;