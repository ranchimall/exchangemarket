'use strict';

const keys = require('./keys');
const blockchain = require('./blockchain');
const conversion_rates = require('./services/conversion').getRate;
const bond_util = require('./services/bonds').util;
const fund_util = require('./services/bobs-fund').util;
const pCode = require('../docs/scripts/floExchangeAPI').processCode;
const DB = require("./database");
const coupling = require('./coupling');
const price = require('./price');

const {
    PERIOD_INTERVAL,
    REQUEST_TIMEOUT
} = require('./_constants')['background'];
const {
    LAUNCH_SELLER_TAG,
    MAXIMUM_LAUNCH_SELL_CHIPS
} = require('./_constants')["market"];

var assetList; //container and allowed assets
var updateBalance; // container for updateBalance function

const verifyTx = {};

function confirmDepositFLO() {
    DB.query("SELECT id, floID, txid FROM VaultTransactions WHERE mode=? AND asset=? AND asset_type=? AND r_status=?", [pCode.VAULT_MODE_DEPOSIT, "FLO", pCode.ASSET_TYPE_COIN, pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => {
            verifyTx.FLO(r.floID, r.txid, keys.sink_groups.EXCHANGE).then(amount => {
                addSellChipsIfLaunchSeller(r.floID, amount).then(txQueries => {
                    txQueries.push(updateBalance.add(r.floID, "FLO", amount));
                    txQueries.push(["UPDATE VaultTransactions SET r_status=?, amount=? WHERE id=?", [pCode.STATUS_SUCCESS, amount, r.id]]);
                    DB.transaction(txQueries)
                        .then(result => console.info("FLO deposited:", r.floID, amount))
                        .catch(error => console.error(error))
                }).catch(error => console.error(error))
            }).catch(error => {
                console.error(error);
                if (error[0])
                    DB.query("UPDATE VaultTransactions SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                        .then(_ => null).catch(error => console.error(error));
            });
        })
    }).catch(error => console.error(error))
}

verifyTx.FLO = function (sender, txid, group) {
    return new Promise((resolve, reject) => {
        floBlockchainAPI.getTx(txid).then(tx => {
            let vin_sender = tx.vin.filter(v => v.addresses[0] === sender)
            if (!vin_sender.length)
                return reject([true, "Transaction not sent by the sender"]);
            if (vin_sender.length !== tx.vin.length)
                return reject([true, "Transaction input containes other floIDs"]);
            if (!tx.blockheight)
                return reject([false, "Transaction not included in any block yet"]);
            if (!tx.confirmations)
                return reject([false, "Transaction not confirmed yet"]);
            let amount = tx.vout.reduce((a, v) => keys.sink_chest.includes(group, v.scriptPubKey.addresses[0]) ? a + v.value : a, 0);
            if (amount == 0)
                return reject([true, "Transaction receiver is not market ID"]); //Maybe reject as false? (to compensate delay in chestsList loading from other nodes)
            else
                resolve(amount);
        }).catch(error => reject([false, error]))
    })
}

function checkTag(floID, tag) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT id FROM UserTag WHERE floID=? AND tag=?", [floID, tag])
            .then(result => resolve(result.length ? true : false))
            .catch(error => reject(error))
    })
}

function addSellChipsIfLaunchSeller(floID, quantity) {
    return new Promise((resolve, reject) => {
        checkTag(floID, LAUNCH_SELLER_TAG).then(result => {
            if (result) //floID is launch-seller
                Promise.all([
                    DB.query("SELECT IFNULL(SUM(quantity), 0) AS sold FROM TradeTransactions WHERE seller=? AND asset=?", [floID, 'FLO']),
                    DB.query("SELECT IFNULL(SUM(quantity), 0) AS brought FROM TradeTransactions WHERE buyer=? AND asset=?", [floID, 'FLO']),
                    DB.query("SELECT IFNULL(SUM(quantity), 0) AS chips FROM SellChips WHERE floID=? AND asset=?", [floID, 'FLO']),
                ]).then(result => {
                    let sold = result[0][0].sold,
                        brought = result[1][0].brought,
                        chips = result[2][0].chips;
                    let remLaunchChips = MAXIMUM_LAUNCH_SELL_CHIPS - (sold + chips) + brought;
                    quantity = Math.min(quantity, remLaunchChips);
                    if (quantity > 0)
                        resolve([["INSERT INTO SellChips(floID, asset, quantity) VALUES (?)", [[floID, 'FLO', quantity]]]]);
                    else
                        resolve([]);
                }).catch(error => reject(error))
            else //floID is not launch-seller
                resolve([]);
        }).catch(error => reject(error))
    })
}

function confirmDepositToken() {
    DB.query("SELECT id, floID, txid FROM VaultTransactions WHERE mode=? AND asset_type=? AND r_status=?", [pCode.VAULT_MODE_DEPOSIT, pCode.ASSET_TYPE_TOKEN, pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => {
            verifyTx.token(r.floID, r.txid, keys.sink_groups.EXCHANGE).then(({ token, amount, flo_amount }) => {
                DB.query("SELECT id FROM VaultTransactions where floID=? AND mode=? AND asset=? AND asset_type=? AND txid=?", [r.floID, pCode.VAULT_MODE_DEPOSIT, "FLO", pCode.ASSET_TYPE_COIN, r.txid]).then(result => {
                    let txQueries = [];
                    //Add the FLO balance if necessary
                    if (!result.length) {
                        txQueries.push(updateBalance.add(r.floID, "FLO", flo_amount));
                        txQueries.push(["INSERT INTO VaultTransactions(txid, floID, mode, asset_type, asset, amount, r_status) VALUES (?)", [[r.txid, r.floID, pCode.VAULT_MODE_DEPOSIT, pCode.ASSET_TYPE_COIN, "FLO", flo_amount, pCode.STATUS_SUCCESS]]]);
                    }
                    txQueries.push(["UPDATE VaultTransactions SET r_status=?, asset=?, amount=? WHERE id=?", [pCode.STATUS_SUCCESS, token, amount, r.id]]);
                    txQueries.push(updateBalance.add(r.floID, token, amount));
                    DB.transaction(txQueries)
                        .then(result => console.info("Token deposited:", r.floID, token, amount))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error));
            }).catch(error => {
                console.error(error);
                if (error[0])
                    DB.query("UPDATE VaultTransactions SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                        .then(_ => null).catch(error => console.error(error));
            });
        })
    }).catch(error => console.error(error))
}

verifyTx.token = function (sender, txid, group, currencyOnly = false) {
    return new Promise((resolve, reject) => {
        floTokenAPI.getTx(txid).then(tx => {
            if (tx.type !== "transfer")
                return reject([true, "Transaction type not 'transfer'"]);
            else if (tx.transferType !== "token")
                return reject([true, "Transaction transfer is not 'token'"]);
            var token = tx.tokenIdentification,
                amount = tx.tokenAmount,
                receiverAddress = tx.receiverAddress,
                senderAddress = tx.senderAddress;
            if (currencyOnly && token !== floGlobals.currency)
                return reject([true, "Token not currency"]);
            else if (!currencyOnly && ((!assetList.includes(token) && token !== floGlobals.currency) || token === "FLO"))
                return reject([true, "Token not authorised"]);
            //let vin_sender = tx.vin.filter(v => v.addr === sender)
            if (senderAddress != sender)
                return reject([true, "Transaction not sent by the sender"]);
            if (!keys.sink_chest.includes(group, receiverAddress))
                return reject([true, "Transaction receiver is not market ID"]); //Maybe reject as false? (to compensate delay in chestsList loading from other nodes)
            let flo_amount = tx.vout.reduce((a, v) => keys.sink_chest.includes(group, v.scriptPubKey.addresses[0]) ? a + v.value : a, 0);
            if (flo_amount == 0)
                return reject([true, "Transaction receiver is not market ID"]); //Maybe reject as false? (to compensate delay in chestsList loading from other nodes)
            else
                resolve({ token, amount, flo_amount });
        }).catch(error => reject([false, error]))
    })
}

function retryVaultWithdrawal() {
    DB.query("SELECT id, floID, asset, asset_type, amount FROM VaultTransactions WHERE mode=? AND r_status=?", [pCode.VAULT_MODE_WITHDRAW, pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => {
            if (r.asset_type == pCode.ASSET_TYPE_COIN) {
                if (r.asset == "FLO")
                    blockchain.withdrawAsset.retry(r.floID, r.asset, r.amount, r.id);
            } else if (r.asset_type == pCode.ASSET_TYPE_TOKEN)
                blockchain.withdrawAsset.retry(r.floID, r.asset, r.amount, r.id)
        })
    }).catch(error => console.error(error))
}

function confirmVaultWithdraw() {
    DB.query("SELECT id, floID, asset, asset_type, amount, txid FROM VaultTransactions WHERE mode=? AND r_status=?", [pCode.VAULT_MODE_WITHDRAW, pCode.STATUS_CONFIRMATION]).then(results => {
        results.forEach(r => {
            if (r.asset_type == pCode.ASSET_TYPE_COIN) {
                if (r.asset == "FLO")
                    floBlockchainAPI.getTx(r.txid).then(tx => {
                        if (!tx.blockheight || !tx.confirmations) //Still not confirmed
                            return;
                        DB.query("UPDATE VaultTransactions SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                            .then(result => console.info("FLO withdrawed:", r.floID, r.amount))
                            .catch(error => console.error(error))
                    }).catch(error => console.error(error));
                else if (r.asset == "BTC")
                    btcOperator.getTx(r.txid).then(tx => {
                        if (!tx.block || !tx.confirmations) //Still not confirmed
                            return;
                        DB.query("UPDATE VaultTransactions SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                            .then(result => console.info("BTC withdrawed:", r.floID, r.amount))
                            .catch(error => console.error(error))
                    }).catch(error => console.error(error));
            } else if (r.asset_type == pCode.ASSET_TYPE_TOKEN)
                floTokenAPI.getTx(r.txid).then(tx => {
                    if (!tx.blockheight || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE VaultTransactions SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info("Token withdrawed:", r.floID, r.asset, r.amount))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error));
        })
    }).catch(error => console.error(error));
}

verifyTx.BTC = function (sender, txid, group) {
    return new Promise((resolve, reject) => {
        btcOperator.getTx(txid).then(tx => {
            let vin_sender = tx.inputs.filter(v => floCrypto.isSameAddr(v.address, sender))
            if (!vin_sender.length)
                return reject([true, "Transaction not sent by the sender"]);
            if (vin_sender.length !== tx.inputs.length)
                return reject([true, "Transaction input containes other floIDs"]);
            if (!tx.block)
                return reject([false, "Transaction not included in any block yet"]);
            if (!tx.confirmations)
                return reject([false, "Transaction not confirmed yet"]);
            let amount = tx.outputs.reduce((a, v) =>
                keys.sink_chest.includes(group, floCrypto.toFloID(v.address, { bech: [coinjs.bech32.version] })) ? a + parseFloat(v.value) : a, 0);
            if (amount == 0)
                return reject([true, "Transaction receiver is not market ID"]); //Maybe reject as false? (to compensate delay in chestsList loading from other nodes)
            else
                resolve(amount);
        }).catch(error => reject([false, error]))
    })
}

function verifyConvert() {
    //Set all timeout convert request to refund mode (thus, asset will be refund if tx gets confirmed later)
    let req_timeout = new Date(Date.now() - REQUEST_TIMEOUT),
        to_refund_sql = "INSERT INTO RefundConvert (floID, in_txid, asset_type, asset, r_status)" +
            " SELECT floID, in_txid, ? AS asset_type, ? AS asset, r_status FROM DirectConvert" +
            " WHERE r_status=? AND locktime<? AND mode=?";
    let txQueries = [];
    txQueries.push([to_refund_sql, [pCode.ASSET_TYPE_TOKEN, floGlobals.currency, pCode.STATUS_PENDING, req_timeout, pCode.CONVERT_MODE_GET]]);
    txQueries.push([to_refund_sql, [pCode.ASSET_TYPE_COIN, "BTC", pCode.STATUS_PENDING, req_timeout, pCode.CONVERT_MODE_PUT]]);
    txQueries.push(["UPDATE DirectConvert SET r_status=? WHERE r_status=? AND locktime<?", [pCode.STATUS_REJECTED, pCode.STATUS_PENDING, req_timeout]]);
    DB.transaction(txQueries).then(result => {
        DB.query("SELECT id, floID, mode, in_txid, amount, quantity FROM DirectConvert WHERE r_status=? AND coin=?", [pCode.STATUS_PENDING, "BTC"]).then(results => {
            results.forEach(r => {
                if (r.mode == pCode.CONVERT_MODE_GET) {
                    verifyTx.token(r.floID, r.in_txid, keys.sink_groups.CONVERT, true).then(({ amount }) => {
                        if (r.amount !== amount)
                            throw ([true, "Transaction amount mismatched in blockchain"]);
                        conversion_rates.BTC_INR().then(rate => {
                            blockchain.convertToCoin.init(r.floID, "BTC", amount, rate, r.id)
                        }).catch(error => console.error(error))
                    }).catch(error => {
                        console.error(error);
                        if (error[0])
                            DB.query("UPDATE DirectConvert SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                                .then(_ => null).catch(error => console.error(error));
                    });
                } else if (r.mode == pCode.CONVERT_MODE_PUT) {
                    verifyTx.BTC(r.floID, r.in_txid, keys.sink_groups.CONVERT).then(quantity => {
                        if (r.quantity !== quantity)
                            throw ([true, "Transaction quantity mismatched in blockchain"]);
                        conversion_rates.BTC_INR().then(rate => {
                            blockchain.convertFromCoin.init(r.floID, quantity, rate, r.id)
                        }).catch(error => console.error(error))
                    }).catch(error => {
                        console.error(error);
                        if (error[0])
                            DB.query("UPDATE DirectConvert SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                                .then(_ => null).catch(error => console.error(error));
                    });
                }
            })
        }).catch(error => console.error(error))
    }).catch(error => console.error(error))
}

function retryConvert() {
    DB.query("SELECT id, floID, mode, amount, quantity FROM DirectConvert WHERE r_status=? AND coin=?", [pCode.STATUS_PROCESSING, "BTC"]).then(results => {
        results.forEach(r => {
            if (r.mode == pCode.CONVERT_MODE_GET)
                blockchain.convertToCoin.retry(r.floID, "BTC", r.quantity, r.id);
            else if (r.mode == pCode.CONVERT_MODE_PUT)
                blockchain.convertFromCoin.retry(r.floID, r.amount, r.id)
        })
    }).catch(error => console.error(error))
}

function confirmConvert() {
    DB.query("SELECT id, floID, mode, amount, quantity, out_txid FROM DirectConvert WHERE r_status=? AND coin=?", [pCode.STATUS_CONFIRMATION, "BTC"]).then(results => {
        results.forEach(r => {
            if (r.mode == pCode.CONVERT_MODE_GET)
                btcOperator.getTx(r.out_txid).then(tx => {
                    if (!tx.block || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE DirectConvert SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info(`${r.floID} converted ${r.amount} to ${r.quantity} BTC`))
                        .catch(error => console.error(error))
                }).catch(error => console.error(error));
            else if (r.mode == pCode.CONVERT_MODE_PUT)
                floTokenAPI.getTx(r.out_txid).then(tx => {
                    if (!tx.blockheight || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE DirectConvert SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info(`${r.floID} converted ${r.quantity} BTC to ${r.amount}`))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error));
        })
    }).catch(error => console.error(error));
}

function verifyConvertFundDeposit() {
    DB.query("SELECT id, mode, txid, coin FROM ConvertFund WHERE r_status=? AND coin=?", [pCode.STATUS_PROCESSING, "BTC"]).then(results => {
        results.forEach(r => {
            if (r.mode == pCode.CONVERT_MODE_GET) { //deposit currency
                verifyTx.token(floGlobals.adminID, r.txid, keys.sink_groups.CONVERT, true).then(({ amount }) => {
                    DB.query("UPDATE ConvertFund SET r_status=?, amount=? WHERE id=?", [pCode.STATUS_SUCCESS, amount, r.id])
                        .then(result => console.info(`Deposit-fund ${amount} ${floGlobals.currency} successful`))
                        .catch(error => console.error(error));
                }).catch(error => {
                    console.error(error);
                    if (error[0])
                        DB.query("UPDATE ConvertFund SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                            .then(_ => null).catch(error => console.error(error));
                });
            } else if (r.mode == pCode.CONVERT_MODE_PUT) {//deposit coin
                verifyTx.BTC(floGlobals.adminID, r.txid, keys.sink_groups.CONVERT).then(quantity => {
                    DB.query("UPDATE ConvertFund SET r_status=?, quantity=? WHERE id=?", [pCode.STATUS_SUCCESS, quantity, r.id])
                        .then(result => console.info(`Deposit-fund ${quantity} ${r.coin} successful`))
                        .catch(error => console.error(error));
                }).catch(error => {
                    console.error(error);
                    if (error[0])
                        DB.query("UPDATE ConvertFund SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                            .then(_ => null).catch(error => console.error(error));
                });
            }
        })
    }).catch(error => console.error(error))
}

function retryConvertFundWithdraw() {
    DB.query("SELECT id, mode, coin, quantity, amount FROM ConvertFund WHERE r_status=? AND coin=?", [pCode.STATUS_PENDING, "BTC"]).then(results => {
        results.forEach(r => {
            if (r.mode == pCode.CONVERT_MODE_GET)  //withdraw coin
                blockchain.convertFundWithdraw.retry(r.coin, r.quantity, r.id);
            else if (r.mode == pCode.CONVERT_MODE_PUT) //withdraw currency
                blockchain.convertFundWithdraw.retry(floGlobals.currency, r.amount, r.id);
        })
    }).catch(error => console.error(error))
}

function confirmConvertFundWithdraw() {
    DB.query("SELECT * FROM ConvertFund WHERE r_status=? AND coin=?", [pCode.STATUS_CONFIRMATION, "BTC"]).then(results => {
        results.forEach(r => {
            if (r.mode == pCode.CONVERT_MODE_GET) { //withdraw coin
                btcOperator.getTx(r.txid).then(tx => {
                    if (!tx.block || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE ConvertFund SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info(`Withdraw-fund ${r.quantity} ${r.coin} successful`))
                        .catch(error => console.error(error))
                }).catch(error => console.error(error));
            } else if (r.mode == pCode.CONVERT_MODE_PUT) {//withdraw currency
                floTokenAPI.getTx(r.txid).then(tx => {
                    if (!tx.blockheight || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE ConvertFund SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info(`Withdraw-fund ${r.amount} ${floGlobals.currency} successful`))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error));
            }
        })
    }).catch(error => console.error(error))
}

function verifyConvertRefund() {
    DB.query("SELECT id, floID, asset_type, asset, in_txid FROM RefundConvert WHERE r_status=?", [pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => {
            if (r.ASSET_TYPE_COIN) {
                if (r.asset == "BTC") //Convert is only for BTC right now
                    verifyTx.BTC(r.floID, r.in_txid, keys.sink_groups.CONVERT)
                        .then(amount => blockchain.refundConvert.init(r.floID, r.asset, amount, r.id))
                        .catch(error => {
                            console.error(error);
                            if (error[0])
                                DB.query("UPDATE RefundConvert SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                                    .then(_ => null).catch(error => console.error(error));
                        });
            } else if (r.ASSET_TYPE_TOKEN)
                verifyTx.token(r.floID, r.in_txid, keys.sink_groups.CONVERT, true).then(({ amount }) => {
                    blockchain.refundConvert.init(r.floID, floGlobals.currency, amount, r.id);
                }).catch(error => {
                    console.error(error);
                    if (error[0])
                        DB.query("UPDATE RefundConvert SET r_status=? WHERE id=?", [pCode.STATUS_REJECTED, r.id])
                            .then(_ => null).catch(error => console.error(error));
                });
        })
    }).catch(error => console.error(error))
}

function retryConvertRefund() {
    DB.query("SELECT id, floID, asset, amount FROM RefundConvert WHERE r_status=?", [pCode.STATUS_PROCESSING]).then(results => {
        results.forEach(r => blockchain.refundConvert.retry(r.floID, r.asset, r.amount, r.id))
    }).catch(error => console.error(error))
}

function confirmConvertRefund() {
    DB.query("SELECT * FROM RefundConvert WHERE r_status=?", [pCode.STATUS_CONFIRMATION]).then(results => {
        results.forEach(r => {
            if (r.ASSET_TYPE_COIN) {
                if (r.asset == "BTC") //Convert is only for BTC right now
                    btcOperator.getTx(r.out_txid).then(tx => {
                        if (!tx.block || !tx.confirmations) //Still not confirmed
                            return;
                        DB.query("UPDATE RefundConvert SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                            .then(result => console.info(`Refunded ${r.amount} ${r.asset} to ${r.floID}`))
                            .catch(error => console.error(error))
                    }).catch(error => console.error(error));
            } else if (r.ASSET_TYPE_TOKEN)
                floTokenAPI.getTx(r.out_txid).then(tx => {
                    if (!tx.blockheight || !tx.confirmations) //Still not confirmed
                        return;
                    DB.query("UPDATE RefundConvert SET r_status=? WHERE id=?", [pCode.STATUS_SUCCESS, r.id])
                        .then(result => console.info(`Refunded ${r.amount} ${r.asset} to ${r.floID}`))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error));
        })
    }).catch(error => console.error(error))
}

function retryBondClosing() {
    DB.query("SELECT id, floID, amount, btc_net, usd_net FROM CloseBondTransact WHERE r_status=?", [pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => blockchain.bondTransact.retry(r.floID, r.amount, r.btc_net, r.usd_net, r.id))
    }).catch(error => console.error(error))
}

function confirmBondClosing() {
    DB.query("SELECT * FROM CloseBondTransact WHERE r_status=?", [pCode.STATUS_CONFIRMATION]).then(results => {
        results.forEach(r => {
            btcOperator.getTx(r.txid).then(tx => {
                if (!tx.block || !tx.confirmations) //Still not confirmed
                    return;
                let closeBondString = bond_util.stringify.end(r.bond_id, r.end_date, r.btc_net, r.usd_net, r.amount, r.ref_sign, r.txid);
                floBlockchainAPI.writeData(keys.node_id, closeBondString, keys.node_priv, bond_util.config.adminID).then(txid => {
                    DB.query("UPDATE CloseBondTransact SET r_status=?, close_id=? WHERE id=?", [pCode.STATUS_SUCCESS, txid, r.id])
                        .then(result => console.info("Bond closed:", r.bond_id))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error))
            }).catch(error => console.error(error));
        })
    }).catch(error => console.error(error))
}

function retryFundClosing() {
    DB.query("SELECT id, floID, amount, btc_net, usd_net FROM CloseFundTransact WHERE r_status=?", [pCode.STATUS_PENDING]).then(results => {
        results.forEach(r => blockchain.fundTransact.retry(r.floID, r.amount, r.btc_net, r.usd_net, r.id))
    }).catch(error => console.error(error))
}

function confirmFundClosing() {
    DB.query("SELECT * FROM CloseFundTransact WHERE r_status=?", [pCode.STATUS_CONFIRMATION]).then(results => {
        results.forEach(r => {
            btcOperator.getTx(r.txid).then(tx => {
                if (!tx.block || !tx.confirmations) //Still not confirmed
                    return;
                let closeFundString = fund_util.stringify.end(r.fund_id, r.floID, r.end_date, r.btc_net, r.usd_net, r.amount, r.ref_sign, r.txid);
                floBlockchainAPI.writeData(keys.node_id, closeFundString, keys.node_priv, fund_util.config.adminID).then(txid => {
                    DB.query("UPDATE CloseFundTransact SET r_status=?, close_id=? WHERE id=?", [pCode.STATUS_SUCCESS, txid, r.id])
                        .then(result => console.info("Fund investment closed:", r.fund_id, r.floID))
                        .catch(error => console.error(error));
                }).catch(error => console.error(error))
            }).catch(error => console.error(error));
        })
    }).catch(error => console.error(error))
}

//Periodic Process

function processAll() {
    //deposit-withdraw asset balance
    if (keys.sink_chest.list(keys.sink_groups.EXCHANGE).length) {
        confirmDepositFLO();
        confirmDepositToken();
        retryVaultWithdrawal();
        confirmVaultWithdraw();
    }
    //convert service
    if (keys.sink_chest.list(keys.sink_groups.CONVERT).length) {
        verifyConvert();
        retryConvert();
        confirmConvert();
        verifyConvertFundDeposit();
        retryConvertFundWithdraw();
        confirmConvertFundWithdraw();
        verifyConvertRefund();
        retryConvertRefund();
        confirmConvertRefund();
    }
    //blockchain-bond service
    if (keys.sink_chest.list(keys.sink_groups.BLOCKCHAIN_BONDS).length) {
        retryBondClosing();
        confirmBondClosing();
    }
    //bob's fund service
    if (keys.sink_chest.list(keys.sink_groups.EXCHANGE).length) {
        retryFundClosing();
        confirmFundClosing();
    }
}

var lastSyncBlockHeight = 0;

function periodicProcess() {
    floBlockchainAPI.promisedAPI('api/status').then(result => {
        let blockbook_height = result.blockbook.bestHeight;
        if (lastSyncBlockHeight < blockbook_height) {
            lastSyncBlockHeight = blockbook_height;
            processAll();
            console.log("Last Block :", lastSyncBlockHeight);
        }
    }).catch(error => console.error(error));
}

function periodicProcess_start() {
    periodicProcess_stop();
    periodicProcess();
    assetList.forEach(asset => coupling.initiate(asset, true));
    price.storeHistory.start();
    periodicProcess.instance = setInterval(periodicProcess, PERIOD_INTERVAL);
}

function periodicProcess_stop() {
    if (periodicProcess.instance !== undefined) {
        clearInterval(periodicProcess.instance);
        delete periodicProcess.instance;
    }
    coupling.stopAll();
    price.storeHistory.stop();
}

module.exports = {
    blockchain,
    periodicProcess: {
        start: periodicProcess_start,
        stop: periodicProcess_stop
    },
    set assetList(assets) {
        assetList = assets;
    },
    set updateBalance(f) {
        updateBalance = f;
    }
}