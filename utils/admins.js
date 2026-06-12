const fs = require("fs");
const path = require("path");

const adminsFile =
  path.join(
    __dirname,
    "admins.json"
  );

console.log(
  "Admins file path:",
  adminsFile
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

  catch(err){

    console.error(
      "loadAdmins error:",
      err
    );

    return [];

  }

}

module.exports = {
  loadAdmins
};