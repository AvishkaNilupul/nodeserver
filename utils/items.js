const fs =
  require("fs");

const path =
  require("path");

const itemsFile =

  path.join(

    __dirname,

    "../items.json"

  );

if(

  !fs.existsSync(
    itemsFile
  )

){

  fs.writeFileSync(

    itemsFile,

    "[]"

  );

}

function loadItems(){

  try{

    return JSON.parse(

      fs.readFileSync(

        itemsFile,

        "utf8"

      )

    ).map(

      item=>({

        used:false,

        usedAt:null,

        ...item

      })

    );

  }

  catch{

    return [];

  }

}

function saveItems(

  items

){

  fs.writeFileSync(

    itemsFile,

    JSON.stringify(

      items,

      null,

      2

    )

  );

}

function addItem(

  category,
  username,
  password,
  notes=""

){

  const items =
    loadItems();

items.push({

  id:

    Date.now()
    .toString(),

  category,

  username,

  password,

  notes,

  used:false,

  usedAt:null,

  createdAt:
    Date.now()

});

  saveItems(
    items
  );

}
function getNextItem(

  category

){

  const items =
    loadItems();

  const item =

    items.find(

      i=>

        i.category
          .toLowerCase()

        ===

        category
          .toLowerCase()

        &&

        !i.used

    );

  if(

    !item

  ){

    return null;

  }

  item.used =
    true;

  item.usedAt =
    Date.now();

  saveItems(
    items
  );

  return item;

}
module.exports = {

  loadItems,

  saveItems,

  addItem,

  getNextItem

};