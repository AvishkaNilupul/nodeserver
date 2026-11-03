const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: {type:String,default:'eldorado'},
  checkedAt: {type:Date,default:null},
  canSell: {type:Boolean,default:null},
  restricted: {type:Boolean,default:null},
  allowHighRiskOffers: {type:Boolean,default:null},
  error: {type:String,default:''},
}, {timestamps:true});
module.exports = mongoose.models.ValorantSalesState || mongoose.model('ValorantSalesState',schema);
