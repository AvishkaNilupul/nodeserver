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

  saveItems,

  getNextItem

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

    notes,

    value

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

        notes,

        value

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
// =========================
// GET NEXT ITEM
// =========================

router.get(

  "/items/next/:category",

  (req,res)=>{

    const item =

      getNextItem(

        req.params.category

      );

    if(

      !item

    ){

      return res
        .status(404)
        .json({

          success:false,

          message:
            "No available items"

        });

    }

    res.json({

      success:true,

      item

    });

  }

);
module.exports =
  router;