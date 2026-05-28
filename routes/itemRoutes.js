const express =
  require(
    "express"
  );

const router =
  express.Router();

const validator =
  require(
    "validator"
  );

const {

  loadItems,
  addItem,
  saveItems

} = require(
  "../utils/items"
);


// =========================
// GET ALL
// =========================

router.get(

  "/items/list",

  (req,res)=>{

    res.json(

      loadItems()

    );

  }

);


// =========================
// ADD ITEM
// =========================

router.post(

  "/items/add",

  (req,res)=>{

    let {

      category,
      username,
      password,
      notes

    } = req.body;

    category =

      validator.escape(

        String(
          category||""
        )

      ).trim();

    username =

      validator.escape(

        String(
          username||""
        )

      ).trim();

    password =

      validator.escape(

        String(
          password||""
        )

      ).trim();

    notes =

      validator.escape(

        String(
          notes||""
        )

      ).trim();

    if(

      !category
      ||
      !username
      ||
      !password

    ){

      return res
        .status(400)
        .json({

          success:false,

          message:
            "Missing fields"

        });

    }

    addItem(

      category,
      username,
      password,
      notes

    );

    res.json({

      success:true

    });

  }

);


// =========================
// DELETE ITEM
// =========================

router.delete(

  "/items/delete/:id",

  (req,res)=>{

    let items =
      loadItems();

    items =

      items.filter(

        item=>

          item.id
          !==
          req.params.id

      );

    saveItems(
      items
    );

    res.json({

      success:true

    });

  }

);

module.exports =
  router;