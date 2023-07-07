'use strict';

const pCode = require('../docs/scripts/floExchangeAPI').processCode;
const { collectAndCall } = require('./backup/head');
const keys = require('./keys');
const DB = require("./database");

const TYPE_VAULT = "VAULT",
    TYPE_CONVERT = "CONVERT",
    TYPE_CONVERT_POOL = "CONVERT_POOL",
    TYPE_CONVERT_REFUND = "REFUND",
    TYPE_BLOCKCHAIN_BOND = "BOND",
    TYPE_BOBS_FUND = "BOB-FUND";

const SINK_GROUP = {
    [TYPE_VAULT]: keys.sink_groups.EXCHANGE,
    [TYPE_CONVERT]: keys.sink_groups.CONVERT,
    [TYPE_CONVERT_POOL]: keys.sink_groups.CONVERT,
    [TYPE_CONVERT_REFUND]: keys.sink_groups.CONVERT,
    [TYPE_BLOCKCHAIN_BOND]: keys.sink_groups.BLOCKCHAIN_BONDS,
    [TYPE_BOBS_FUND]: keys.sink_groups.BOBS_FUND
}

const balance_locked = {},
    balance_cache = {},
    callbackCollection = {
        [TYPE_VAULT]: {},
        [TYPE_CONVERT]: {},
        [TYPE_CONVERT_POOL]: {},
        [TYPE_CONVERT_REFUND]: {},
        [TYPE_BLOCKCHAIN_BOND]: {},
        [TYPE_BOBS_FUND]: {}
    };

function getBalance(sinkID, asset) {
    switch (asset) {
        case "FLO":
            return floBlockchainAPI.getBalance(sinkID);
        case "BTC":
            let btc_id = btcOperator.convert.legacy2bech(sinkID);
            return btcOperator.getBalance(btc_id);
        default:
            return floTokenAPI.getBalance(sinkID, asset);
    }
}

function getSinkID(type, quantity, asset, sinkList = null) {
    return new Promise((resolve, reject) => {
        if (!sinkList)
            sinkList = keys.sink_chest.list(SINK_GROUP[type]).map(s => [s, s in balance_cache ? balance_cache[s][asset] || 0 : 0]) //TODO: improve sorting
                .sort((a, b) => b[1] - a[1]).map(x => x[0]);
        if (!sinkList.length)
            return reject(`Insufficient balance for asset(${asset}) in chest(${SINK_GROUP[type]})`);
        let sinkID = sinkList.shift();
        getBalance(sinkID, asset).then(balance => {
            if (!(sinkID in balance_cache))
                balance_cache[sinkID] = {};
            balance_cache[sinkID][asset] = balance;
            if (balance > (quantity + (sinkID in balance_locked ? balance_locked[sinkID][asset] || 0 : 0)))
                return resolve(sinkID);
            else
                getSinkID(type, quantity, asset, sinkList)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
        }).catch(error => {
            console.error(error);
            getSinkID(type, quantity, asset, sinkList)
                .then(result => resolve(result))
                .catch(error => reject(error))
        });
    })
}

const WITHDRAWAL_MESSAGE = {
    [TYPE_VAULT]: "(withdrawal from market)",
    [TYPE_CONVERT]: "(convert coin)",
    [TYPE_CONVERT_POOL]: "(convert fund)",
    [TYPE_CONVERT_REFUND]: "(refund from market)",
    [TYPE_BLOCKCHAIN_BOND]: "(bond closing)",
    [TYPE_BOBS_FUND]: "(fund investment closing)"
}

function sendTx(floID, asset, quantity, sinkID, sinkKey, message) {
    switch (asset) {
        case "FLO":
            return floBlockchainAPI.sendTx(sinkID, floID, quantity, sinkKey, message);
        case "BTC":
            let btc_sinkID = btcOperator.convert.legacy2bech(sinkID),
                btc_receiver = btcOperator.convert.legacy2bech(floID);
            return btcOperator.sendTx(btc_sinkID, sinkKey, btc_receiver, quantity, null, { fee_from_receiver: true });
        default:
            return floTokenAPI.sendToken(sinkKey, quantity, floID, message, asset);
    }
}

const updateSyntax = {
    [TYPE_VAULT]: "UPDATE VaultTransactions SET r_status=?, txid=? WHERE id=?",
    [TYPE_CONVERT]: "UPDATE DirectConvert SET r_status=?, out_txid=? WHERE id=?",
    [TYPE_CONVERT_POOL]: "UPDATE ConvertFund SET r_status=?, txid=? WHERE id=?",
    [TYPE_CONVERT_REFUND]: "UPDATE RefundConvert SET r_status=?, out_txid=? WHERE id=?",
    [TYPE_BLOCKCHAIN_BOND]: "UPDATE CloseBondTransact SET r_status=?, txid=? WHERE id=?",
    [TYPE_BOBS_FUND]: "UPDATE CloseFundTransact SET r_status=?, txid=? WHERE id=?"
};

function sendAsset(floID, asset, quantity, type, id) {
    quantity = global.toStandardDecimal(quantity);
    getSinkID(type, quantity, asset).then(sinkID => {
        let callback = (sinkKey) => {
            //Send asset to user via API
            sendTx(floID, asset, quantity, sinkID, sinkKey, WITHDRAWAL_MESSAGE[type]).then(txid => {
                if (!txid)
                    console.error("Transaction not successful");
                else //Transaction was successful, Add in database
                    DB.query(updateSyntax[type], [pCode.STATUS_CONFIRMATION, txid, id])
                        .then(_ => null).catch(error => console.error(error));
            }).catch(error => console.error(error)).finally(_ => {
                delete callbackCollection[type][id];
                balance_locked[sinkID][asset] -= quantity;
            });
        }
        collectAndCall(SINK_GROUP[type], sinkID, callback); //TODO: add timeout to prevent infinite wait
        callbackCollection[type][id] = callback;
        if (!(sinkID in balance_locked))
            balance_locked[sinkID] = {};
        balance_locked[sinkID][asset] = (balance_locked[sinkID][asset] || 0) + quantity;
    }).catch(error => console.error(error))
}

function withdrawAsset_init(floID, asset, amount) {
    amount = global.toStandardDecimal(amount);
    let asset_type = ["FLO", "BTC"].includes(asset) ? pCode.ASSET_TYPE_COIN : pCode.ASSET_TYPE_TOKEN;
    DB.query("INSERT INTO VaultTransactions (floID, mode, asset_type, asset, amount, r_status) VALUES (?)", [[floID, pCode.VAULT_MODE_WITHDRAW, asset_type, asset, amount, pCode.STATUS_PENDING]])
        .then(result => sendAsset(floID, asset, amount, TYPE_VAULT, result.insertId))
        .catch(error => console.error(error))
}

function withdrawAsset_retry(floID, asset, amount, id) {
    if (id in callbackCollection[TYPE_VAULT])
        console.debug("A callback is already pending for this Coin transfer");
    else sendAsset(floID, asset, amount, TYPE_VAULT, id);
}

function convertToCoin_init(floID, coin, currency_amount, rate, id) {
    let coin_quantity = global.toStandardDecimal(currency_amount / rate);
    DB.query("UPDATE DirectConvert SET quantity=?, r_status=?, rate=?, locktime=DEFAULT WHERE id=?", [coin_quantity, pCode.STATUS_PROCESSING, rate, id])
        .then(result => sendAsset(floID, coin, coin_quantity, TYPE_CONVERT, id))
        .catch(error => console.error(error))
}

function convertToCoin_retry(floID, coin, coin_quantity, id) {
    if (id in callbackCollection[TYPE_CONVERT])
        console.debug("A callback is already pending for this Coin convert");
    else sendAsset(floID, coin, coin_quantity, TYPE_CONVERT, id);
}

function convertFromCoin_init(floID, coin_quantity, rate, id) {
    let currency_amount = global.toStandardDecimal(coin_quantity * rate);
    DB.query("UPDATE DirectConvert SET amount=?, r_status=?, rate=?, locktime=DEFAULT WHERE id=?", [currency_amount, pCode.STATUS_PROCESSING, rate, id])
        .then(result => sendAsset(floID, floGlobals.currency, currency_amount, TYPE_CONVERT, id))
        .catch(error => console.error(error))
}

function convertFromCoin_retry(floID, currency_amount, id) {
    if (id in callbackCollection[TYPE_CONVERT])
        console.debug("A callback is already pending for this Coin Convert");
    else sendAsset(floID, floGlobals.currency, currency_amount, TYPE_CONVERT, id);
}

function convertFundWithdraw_retry(asset, amount, id) {
    if (id in callbackCollection[TYPE_CONVERT_POOL])
        console.debug("A callback is already pending for this Convert fund withdrawal");
    else sendAsset(floGlobals.adminID, asset, amount, TYPE_CONVERT_POOL, id);
}

function bondTransact_retry(floID, amount, btc_rate, usd_rate, id) {
    if (id in callbackCollection[TYPE_BLOCKCHAIN_BOND])
        console.debug("A callback is already pending for this Bond closing");
    else sendAsset(floID, "BTC", amount / (btc_rate * usd_rate), TYPE_BLOCKCHAIN_BOND, id);
}
function fundTransact_retry(floID, amount, btc_rate, usd_rate, id) {
    if (id in callbackCollection[TYPE_BOBS_FUND])
        console.debug("A callback is already pending for this Fund investment closing");
    else sendAsset(floID, "BTC", amount / (btc_rate * usd_rate), TYPE_BOBS_FUND, id);
}

function refundConvert_init(floID, asset, amount, id) {
    amount = global.toStandardDecimal(amount);
    DB.query("UPDATE RefundConvert SET amount=?, r_status=?, locktime=DEFAULT WHERE id=?", [amount, pCode.STATUS_PROCESSING, id])
        .then(result => sendAsset(floID, asset, amount, TYPE_CONVERT_REFUND, id))
        .catch(error => console.error(error))
}

function refundConvert_retry(floID, asset, amount, id) {
    if (id in callbackCollection[TYPE_CONVERT_REFUND])
        console.debug("A callback is already pending for this Refund");
    else sendAsset(floID, asset, amount, TYPE_CONVERT_REFUND, id);
}

module.exports = {
    withdrawAsset: {
        init: withdrawAsset_init,
        retry: withdrawAsset_retry
    },
    convertToCoin: {
        init: convertToCoin_init,
        retry: convertToCoin_retry
    },
    convertFromCoin: {
        init: convertFromCoin_init,
        retry: convertFromCoin_retry
    },
    convertFundWithdraw: {
        retry: convertFundWithdraw_retry
    },
    bondTransact: {
        retry: bondTransact_retry
    },
    fundTransact: {
        retry: fundTransact_retry
    },
    refundConvert: {
        init: refundConvert_init,
        retry: refundConvert_retry
    }
}