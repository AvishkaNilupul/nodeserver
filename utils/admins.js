const fs = require("fs");
const path = require("path");

const adminsFile =
  path.join(
    __dirname,
    "../admins.json"
  );

function loadAdmins(){

  try{

    return JSON.parse(
      fs.readFileSync(
        adminsFile,
        "utf8"
      )
    );

  }

  catch{

    return [];

  }

}

module.exports = {
  loadAdmins
};