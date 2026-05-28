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

    createdAt:
      Date.now()

  });

  saveItems(
    items
  );

}

module.exports = {

  loadItems,
  saveItems,
  addItem

};