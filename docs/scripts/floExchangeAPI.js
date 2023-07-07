'use strict';

(function (EXPORTS) { //floExchangeAPI v1.2.1
    const exchangeAPI = EXPORTS;

    const DEFAULT = {
        marketID: floGlobals.marketID || "FMxYC7gYZhouzqtHZukGnPiQ8nvG4CMzXM",
        marketApp: "exchange"
    }

    /*Kademlia DHT K-bucket implementation as a binary tree.*/
    /**
     * Implementation of a Kademlia DHT k-bucket used for storing
     * contact (peer node) information.
     *
     * @extends EventEmitter
     */
    function BuildKBucket(options = {}) {
        /**
         * `options`:
         *   `distance`: Function
         *     `function (firstId, secondId) { return distance }` An optional
         *     `distance` function that gets two `id` Uint8Arrays
         *     and return distance (as number) between them.
         *   `arbiter`: Function (Default: vectorClock arbiter)
         *     `function (incumbent, candidate) { return contact; }` An optional
         *     `arbiter` function that givent two `contact` objects with the same `id`
         *     returns the desired object to be used for updating the k-bucket. For
         *     more details, see [arbiter function](#arbiter-function).
         *   `localNodeId`: Uint8Array An optional Uint8Array representing the local node id.
         *     If not provided, a local node id will be created via `randomBytes(20)`.
         *     `metadata`: Object (Default: {}) Optional satellite data to include
         *     with the k-bucket. `metadata` property is guaranteed not be altered by,
         *     it is provided as an explicit container for users of k-bucket to store
         *     implementation-specific data.
         *   `numberOfNodesPerKBucket`: Integer (Default: 20) The number of nodes
         *     that a k-bucket can contain before being full or split.
         *     `numberOfNodesToPing`: Integer (Default: 3) The number of nodes to
         *     ping when a bucket that should not be split becomes full. KBucket will
         *     emit a `ping` event that contains `numberOfNodesToPing` nodes that have
         *     not been contacted the longest.
         *
         * @param {Object=} options optional
         */

        this.localNodeId = options.localNodeId || window.crypto.getRandomValues(new Uint8Array(20))
        this.numberOfNodesPerKBucket = options.numberOfNodesPerKBucket || 20
        this.numberOfNodesToPing = options.numberOfNodesToPing || 3
        this.distance = options.distance || this.distance
        // use an arbiter from options or vectorClock arbiter by default
        this.arbiter = options.arbiter || this.arbiter
        this.metadata = Object.assign({}, options.metadata)

        this.createNode = function () {
            return {
                contacts: [],
                dontSplit: false,
                left: null,
                right: null
            }
        }

        this.ensureInt8 = function (name, val) {
            if (!(val instanceof Uint8Array)) {
                throw new TypeError(name + ' is not a Uint8Array')
            }
        }

        /**
         * @param  {Uint8Array} array1
         * @param  {Uint8Array} array2
         * @return {Boolean}
         */
        this.arrayEquals = function (array1, array2) {
            if (array1 === array2) {
                return true
            }
            if (array1.length !== array2.length) {
                return false
            }
            for (let i = 0, length = array1.length; i < length; ++i) {
                if (array1[i] !== array2[i]) {
                    return false
                }
            }
            return true
        }

        this.ensureInt8('option.localNodeId as parameter 1', this.localNodeId)
        this.root = this.createNode()

        /**
         * Default arbiter function for contacts with the same id. Uses
         * contact.vectorClock to select which contact to update the k-bucket with.
         * Contact with larger vectorClock field will be selected. If vectorClock is
         * the same, candidat will be selected.
         *
         * @param  {Object} incumbent Contact currently stored in the k-bucket.
         * @param  {Object} candidate Contact being added to the k-bucket.
         * @return {Object}           Contact to updated the k-bucket with.
         */
        this.arbiter = function (incumbent, candidate) {
            return incumbent.vectorClock > candidate.vectorClock ? incumbent : candidate
        }

        /**
         * Default distance function. Finds the XOR
         * distance between firstId and secondId.
         *
         * @param  {Uint8Array} firstId  Uint8Array containing first id.
         * @param  {Uint8Array} secondId Uint8Array containing second id.
         * @return {Number}              Integer The XOR distance between firstId
         *                               and secondId.
         */
        this.distance = function (firstId, secondId) {
            let distance = 0
            let i = 0
            const min = Math.min(firstId.length, secondId.length)
            const max = Math.max(firstId.length, secondId.length)
            for (; i < min; ++i) {
                distance = distance * 256 + (firstId[i] ^ secondId[i])
            }
            for (; i < max; ++i) distance = distance * 256 + 255
            return distance
        }

        /**
         * Adds a contact to the k-bucket.
         *
         * @param {Object} contact the contact object to add
         */
        this.add = function (contact) {
            this.ensureInt8('contact.id', (contact || {}).id)

            let bitIndex = 0
            let node = this.root

            while (node.contacts === null) {
                // this is not a leaf node but an inner node with 'low' and 'high'
                // branches; we will check the appropriate bit of the identifier and
                // delegate to the appropriate node for further processing
                node = this._determineNode(node, contact.id, bitIndex++)
            }

            // check if the contact already exists
            const index = this._indexOf(node, contact.id)
            if (index >= 0) {
                this._update(node, index, contact)
                return this
            }

            if (node.contacts.length < this.numberOfNodesPerKBucket) {
                node.contacts.push(contact)
                return this
            }

            // the bucket is full
            if (node.dontSplit) {
                // we are not allowed to split the bucket
                // we need to ping the first this.numberOfNodesToPing
                // in order to determine if they are alive
                // only if one of the pinged nodes does not respond, can the new contact
                // be added (this prevents DoS flodding with new invalid contacts)
                return this
            }

            this._split(node, bitIndex)
            return this.add(contact)
        }

        /**
         * Get the n closest contacts to the provided node id. "Closest" here means:
         * closest according to the XOR metric of the contact node id.
         *
         * @param  {Uint8Array} id  Contact node id
         * @param  {Number=} n      Integer (Default: Infinity) The maximum number of
         *                          closest contacts to return
         * @return {Array}          Array Maximum of n closest contacts to the node id
         */
        this.closest = function (id, n = Infinity) {
            this.ensureInt8('id', id)

            if ((!Number.isInteger(n) && n !== Infinity) || n <= 0) {
                throw new TypeError('n is not positive number')
            }

            let contacts = []

            for (let nodes = [this.root], bitIndex = 0; nodes.length > 0 && contacts.length < n;) {
                const node = nodes.pop()
                if (node.contacts === null) {
                    const detNode = this._determineNode(node, id, bitIndex++)
                    nodes.push(node.left === detNode ? node.right : node.left)
                    nodes.push(detNode)
                } else {
                    contacts = contacts.concat(node.contacts)
                }
            }

            return contacts
                .map(a => [this.distance(a.id, id), a])
                .sort((a, b) => a[0] - b[0])
                .slice(0, n)
                .map(a => a[1])
        }

        /**
         * Counts the total number of contacts in the tree.
         *
         * @return {Number} The number of contacts held in the tree
         */
        this.count = function () {
            // return this.toArray().length
            let count = 0
            for (const nodes = [this.root]; nodes.length > 0;) {
                const node = nodes.pop()
                if (node.contacts === null) nodes.push(node.right, node.left)
                else count += node.contacts.length
            }
            return count
        }

        /**
         * Determines whether the id at the bitIndex is 0 or 1.
         * Return left leaf if `id` at `bitIndex` is 0, right leaf otherwise
         *
         * @param  {Object} node     internal object that has 2 leafs: left and right
         * @param  {Uint8Array} id   Id to compare localNodeId with.
         * @param  {Number} bitIndex Integer (Default: 0) The bit index to which bit
         *                           to check in the id Uint8Array.
         * @return {Object}          left leaf if id at bitIndex is 0, right leaf otherwise.
         */
        this._determineNode = function (node, id, bitIndex) {
            // *NOTE* remember that id is a Uint8Array and has granularity of
            // bytes (8 bits), whereas the bitIndex is the bit index (not byte)

            // id's that are too short are put in low bucket (1 byte = 8 bits)
            // (bitIndex >> 3) finds how many bytes the bitIndex describes
            // bitIndex % 8 checks if we have extra bits beyond byte multiples
            // if number of bytes is <= no. of bytes described by bitIndex and there
            // are extra bits to consider, this means id has less bits than what
            // bitIndex describes, id therefore is too short, and will be put in low
            // bucket
            const bytesDescribedByBitIndex = bitIndex >> 3
            const bitIndexWithinByte = bitIndex % 8
            if ((id.length <= bytesDescribedByBitIndex) && (bitIndexWithinByte !== 0)) {
                return node.left
            }

            const byteUnderConsideration = id[bytesDescribedByBitIndex]

            // byteUnderConsideration is an integer from 0 to 255 represented by 8 bits
            // where 255 is 11111111 and 0 is 00000000
            // in order to find out whether the bit at bitIndexWithinByte is set
            // we construct (1 << (7 - bitIndexWithinByte)) which will consist
            // of all bits being 0, with only one bit set to 1
            // for example, if bitIndexWithinByte is 3, we will construct 00010000 by
            // (1 << (7 - 3)) -> (1 << 4) -> 16
            if (byteUnderConsideration & (1 << (7 - bitIndexWithinByte))) {
                return node.right
            }

            return node.left
        }

        /**
         * Get a contact by its exact ID.
         * If this is a leaf, loop through the bucket contents and return the correct
         * contact if we have it or null if not. If this is an inner node, determine
         * which branch of the tree to traverse and repeat.
         *
         * @param  {Uint8Array} id The ID of the contact to fetch.
         * @return {Object|Null}   The contact if available, otherwise null
         */
        this.get = function (id) {
            this.ensureInt8('id', id)

            let bitIndex = 0

            let node = this.root
            while (node.contacts === null) {
                node = this._determineNode(node, id, bitIndex++)
            }

            // index of uses contact id for matching
            const index = this._indexOf(node, id)
            return index >= 0 ? node.contacts[index] : null
        }

        /**
         * Returns the index of the contact with provided
         * id if it exists, returns -1 otherwise.
         *
         * @param  {Object} node    internal object that has 2 leafs: left and right
         * @param  {Uint8Array} id  Contact node id.
         * @return {Number}         Integer Index of contact with provided id if it
         *                          exists, -1 otherwise.
         */
        this._indexOf = function (node, id) {
            for (let i = 0; i < node.contacts.length; ++i) {
                if (this.arrayEquals(node.contacts[i].id, id)) return i
            }

            return -1
        }

        /**
         * Removes contact with the provided id.
         *
         * @param  {Uint8Array} id The ID of the contact to remove.
         * @return {Object}        The k-bucket itself.
         */
        this.remove = function (id) {
            this.ensureInt8('the id as parameter 1', id)

            let bitIndex = 0
            let node = this.root

            while (node.contacts === null) {
                node = this._determineNode(node, id, bitIndex++)
            }

            const index = this._indexOf(node, id)
            if (index >= 0) {
                const contact = node.contacts.splice(index, 1)[0]
            }

            return this
        }

        /**
         * Splits the node, redistributes contacts to the new nodes, and marks the
         * node that was split as an inner node of the binary tree of nodes by
         * setting this.root.contacts = null
         *
         * @param  {Object} node     node for splitting
         * @param  {Number} bitIndex the bitIndex to which byte to check in the
         *                           Uint8Array for navigating the binary tree
         */
        this._split = function (node, bitIndex) {
            node.left = this.createNode()
            node.right = this.createNode()

            // redistribute existing contacts amongst the two newly created nodes
            for (const contact of node.contacts) {
                this._determineNode(node, contact.id, bitIndex).contacts.push(contact)
            }

            node.contacts = null // mark as inner tree node

            // don't split the "far away" node
            // we check where the local node would end up and mark the other one as
            // "dontSplit" (i.e. "far away")
            const detNode = this._determineNode(node, this.localNodeId, bitIndex)
            const otherNode = node.left === detNode ? node.right : node.left
            otherNode.dontSplit = true
        }

        /**
         * Returns all the contacts contained in the tree as an array.
         * If this is a leaf, return a copy of the bucket. `slice` is used so that we
         * don't accidentally leak an internal reference out that might be
         * accidentally misused. If this is not a leaf, return the union of the low
         * and high branches (themselves also as arrays).
         *
         * @return {Array} All of the contacts in the tree, as an array
         */
        this.toArray = function () {
            let result = []
            for (const nodes = [this.root]; nodes.length > 0;) {
                const node = nodes.pop()
                if (node.contacts === null) nodes.push(node.right, node.left)
                else result = result.concat(node.contacts)
            }
            return result
        }

        /**
         * Updates the contact selected by the arbiter.
         * If the selection is our old contact and the candidate is some new contact
         * then the new contact is abandoned (not added).
         * If the selection is our old contact and the candidate is our old contact
         * then we are refreshing the contact and it is marked as most recently
         * contacted (by being moved to the right/end of the bucket array).
         * If the selection is our new contact, the old contact is removed and the new
         * contact is marked as most recently contacted.
         *
         * @param  {Object} node    internal object that has 2 leafs: left and right
         * @param  {Number} index   the index in the bucket where contact exists
         *                          (index has already been computed in a previous
         *                          calculation)
         * @param  {Object} contact The contact object to update.
         */
        this._update = function (node, index, contact) {
            // sanity check
            if (!this.arrayEquals(node.contacts[index].id, contact.id)) {
                throw new Error('wrong index for _update')
            }

            const incumbent = node.contacts[index]
            const selection = this.arbiter(incumbent, contact)
            // if the selection is our old contact and the candidate is some new
            // contact, then there is nothing to do
            if (selection === incumbent && incumbent !== contact) return

            node.contacts.splice(index, 1) // remove old contact
            node.contacts.push(selection) // add more recent contact version

        }
    }

    const K_Bucket = exchangeAPI.K_Bucket = function K_Bucket(masterID, backupList) {
        const decodeID = function (floID) {
            let k = bitjs.Base58.decode(floID);
            k.shift();
            k.splice(-4, 4);
            const decodedId = Crypto.util.bytesToHex(k);
            const nodeIdBigInt = new BigInteger(decodedId, 16);
            const nodeIdBytes = nodeIdBigInt.toByteArrayUnsigned();
            const nodeIdNewInt8Array = new Uint8Array(nodeIdBytes);
            return nodeIdNewInt8Array;
        };
        const _KB = new BuildKBucket({
            localNodeId: decodeID(masterID)
        });
        backupList.forEach(id => _KB.add({
            id: decodeID(id),
            floID: id
        }));
        const orderedList = backupList.map(sn => [_KB.distance(decodeID(masterID), decodeID(sn)), sn])
            .sort((a, b) => a[0] - b[0])
            .map(a => a[1]);
        const self = this;

        Object.defineProperty(self, 'order', {
            get: () => Array.from(orderedList)
        });

        self.closestNode = function (id, N = 1) {
            let decodedId = decodeID(id);
            let n = N || orderedList.length;
            let cNodes = _KB.closest(decodedId, n)
                .map(k => k.floID);
            return (N == 1 ? cNodes[0] : cNodes);
        };

        self.isBefore = (source, target) => orderedList.indexOf(target) < orderedList.indexOf(source);
        self.isAfter = (source, target) => orderedList.indexOf(target) > orderedList.indexOf(source);
        self.isPrev = (source, target) => orderedList.indexOf(target) === orderedList.indexOf(source) - 1;
        self.isNext = (source, target) => orderedList.indexOf(target) === orderedList.indexOf(source) + 1;

        self.prevNode = function (id, N = 1) {
            let n = N || orderedList.length;
            if (!orderedList.includes(id))
                throw Error(`${id} is not in KB list`);
            let pNodes = orderedList.slice(0, orderedList.indexOf(id)).slice(-n);
            return (N == 1 ? pNodes[0] : pNodes);
        };

        self.nextNode = function (id, N = 1) {
            let n = N || orderedList.length;
            if (!orderedList.includes(id))
                throw Error(`${id} is not in KB list`);
            let nNodes = orderedList.slice(orderedList.indexOf(id) + 1).slice(0, n);
            return (N == 1 ? nNodes[0] : nNodes);
        };

    }

    var nodeList, nodeURL, nodeKBucket; //Container for (backup) node list

    Object.defineProperties(exchangeAPI, {
        adminID: {
            get: () => DEFAULT.marketID
        },
        application: {
            get: () => DEFAULT.marketApp
        },
        nodeList: {
            get: () => {
                if (Array.isArray(nodeList))
                    return Array.from(nodeList);
                else
                    throw "Exchange API is not loaded";
            }
        }
    });

    function fetch_api(api, options) {
        return new Promise((resolve, reject) => {
            let curPos = fetch_api.curPos || 0;
            if (curPos >= nodeList.length)
                return reject(ExchangeError(ExchangeError.NODES_OFFLINE_CODE, 'No Node online! Refresh the page or try again later', errorCode.NODES_OFFLINE));
            let url = "https://" + nodeURL[nodeList[curPos]];
            (options ? fetch(url + api, options) : fetch(url + api))
                .then(result => resolve(result)).catch(error => {
                    console.warn(nodeList[curPos], 'is offline');
                    //try next node
                    fetch_api.curPos = curPos + 1;
                    fetch_api(api, options)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                });
        })
    }

    const errorCode = exchangeAPI.errorCode = {
        INCORRECT_SERVER: '000',

        //INVALID INPUTS: 0XX
        INVALID_REQUEST_FORMAT: '001',
        ACCESS_DENIED: '002',
        INVALID_FLO_ID: '011',
        INVALID_LOGIN_CODE: '012',
        INVALID_PRIVATE_KEY: '013',
        INVALID_PUBLIC_KEY: '014',
        INVALID_SIGNATURE: '015',
        EXPIRED_SIGNATURE: '016',
        DUPLICATE_SIGNATURE: '017',
        SESSION_INVALID: '018',
        SESSION_EXPIRED: '019',
        INVALID_VALUE: '020',
        INVALID_TOKEN_NAME: '021',
        INVALID_NUMBER: '022',
        INVALID_TYPE: '023',
        INVALID_TX_ID: '024',
        INVALID_TAG: '025',
        MISSING_PARAMETER: '099',

        //INCORRECT DATA: 1XX
        NOT_FOUND: '101',
        NOT_OWNER: '102',
        DUPLICATE_ENTRY: '103',

        //INSUFFICIENT: 2XX
        INSUFFICIENT_BALANCE: '201',
        INSUFFICIENT_SELLCHIP: '203',
        GREATER_SELLCHIP_BASE: '204',
        INSUFFICIENT_PERIOD: '206',
        INSUFFICIENT_FUND: '207',

        //OTHERS
        NODES_OFFLINE: '404',
        INTERNAL_ERROR: '500'
    };

    const parseErrorCode = exchangeAPI.parseErrorCode = function (message) {
        let code = message.match(/^E\d{3}:/g);
        if (!code || !code.length)
            return null;
        else
            return code[0].substring(1, 4);
    }

    function ExchangeError(status, message, code = null) {
        if (parseErrorCode(message) === errorCode.INCORRECT_SERVER)
            location.reload();
        else if (this instanceof ExchangeError) {
            this.code = code || parseErrorCode(message);
            this.message = message.replace(/^E\d{3}:/g, '').trim();
            this.status = status;
        } else
            return new ExchangeError(status, message, code);
    }

    ExchangeError.BAD_REQUEST_CODE = 400;
    ExchangeError.BAD_RESPONSE_CODE = 500;
    ExchangeError.NODES_OFFLINE_CODE = 404;

    function responseParse(response, json_ = true) {
        return new Promise((resolve, reject) => {
            if (!response.ok)
                response.text()
                    .then(result => reject(ExchangeError(response.status, result)))
                    .catch(error => reject(ExchangeError(response.status, error)));
            else if (json_)
                response.json()
                    .then(result => resolve(result))
                    .catch(error => reject(ExchangeError(ExchangeError.BAD_RESPONSE_CODE, error)));
            else
                response.text()
                    .then(result => resolve(result))
                    .catch(error => reject(ExchangeError(ExchangeError.BAD_RESPONSE_CODE, error)));
        });
    }

    const processCode = exchangeAPI.processCode = {
        ASSET_TYPE_COIN: 0,
        ASSET_TYPE_TOKEN: 1,

        VAULT_MODE_DEPOSIT: 1,
        VAULT_MODE_WITHDRAW: 0,

        STATUS_PENDING: 0,
        STATUS_PROCESSING: 1,
        STATUS_CONFIRMATION: 90,
        STATUS_REJECTED: -1,
        STATUS_SUCCESS: 100,

        CONVERT_MODE_GET: 1,
        CONVERT_MODE_PUT: 0,
    }

    const serviceList = exchangeAPI.serviceList = {
        EXCHANGE: "exchange",
        CONVERT: "convert",
        BLOCKCHAIN_BOND: "blockchain-bond",
        BOBS_FUND: "bobs-fund"
    }

    const getSink = exchangeAPI.getSink = function (service = serviceList.EXCHANGE) {
        return new Promise((resolve, reject) => {
            if (!(Object.values(serviceList).includes(service)))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, 'service required', errorCode.INVALID_VALUE));
            fetch_api('/get-sink?service=' + service)
                .then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        })
    }

    exchangeAPI.getAccount = function (floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "get_account",
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/account', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error));
        });
    }

    exchangeAPI.getBuyList = function (asset = null) {
        return new Promise((resolve, reject) => {
            fetch_api('/list-buyorders' + (asset ? "?asset=" + asset : ""))
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        });
    }

    exchangeAPI.getSellList = function (asset = null) {
        return new Promise((resolve, reject) => {
            fetch_api('/list-sellorders' + (asset ? "?asset=" + asset : ""))
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        });
    }

    exchangeAPI.getTradeList = function (asset = null) {
        return new Promise((resolve, reject) => {
            fetch_api('/list-trades' + (asset ? "?asset=" + asset : ""))
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        });
    }

    exchangeAPI.getRates = function (asset = null) {
        return new Promise((resolve, reject) => {
            fetch_api('/get-rates' + (asset ? "?asset=" + asset : ""))
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        });
    }

    exchangeAPI.getRateHistory = function (asset, duration = null) {
        return new Promise((resolve, reject) => {
            fetch_api('/rate-history?asset=' + asset + (duration ? '&duration=' + duration : ""))
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        });
    }

    exchangeAPI.getBalance = function (floID = null, token = null) {
        return new Promise((resolve, reject) => {
            if (!floID && !token)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Need atleast one argument", errorCode.MISSING_PARAMETER));
            let queryStr = (floID ? "floID=" + floID : "") +
                (floID && token ? "&" : "") +
                (token ? "token=" + token : "");
            fetch_api('/get-balance?' + queryStr)
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        })
    }

    exchangeAPI.getTx = function (txid) {
        return new Promise((resolve, reject) => {
            if (!txid)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, 'txid required', errorCode.MISSING_PARAMETER));
            fetch_api('/get-transaction?txid=' + txid)
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        })
    }

    function signRequest(request, signKey) {
        if (typeof request !== "object")
            throw Error("Request is not an object");
        let req_str = Object.keys(request).sort().map(r => r + ":" + request[r]).join("|");
        return floCrypto.signData(req_str, signKey);
    }

    exchangeAPI.getLoginCode = function () {
        return new Promise((resolve, reject) => {
            fetch_api('/get-login-code')
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        })
    }

    exchangeAPI.login = function (privKey, proxyKey, code, hash) {
        return new Promise((resolve, reject) => {
            if (!code || !hash)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Login Code missing", errorCode.MISSING_PARAMETER));
            let request = {
                proxyKey: proxyKey,
                floID: floCrypto.getFloID(privKey),
                pubKey: floCrypto.getPubKeyHex(privKey),
                timestamp: Date.now(),
                code: code,
                hash: hash
            };
            if (!privKey || !request.floID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private key", errorCode.INVALID_PRIVATE_KEY));
            request.sign = signRequest({
                type: "login",
                random: code,
                proxyKey: proxyKey,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api("/login", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error));
        })
    }

    exchangeAPI.logout = function (floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "logout",
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api("/logout", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.buy = function (asset, quantity, max_price, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            if (typeof quantity !== "number" || quantity <= 0)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid quantity (${quantity})`, errorCode.INVALID_NUMBER));
            else if (typeof max_price !== "number" || max_price <= 0)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid max_price (${max_price})`, errorCode.INVALID_NUMBER));
            let request = {
                floID: floID,
                asset: asset,
                quantity: quantity,
                max_price: max_price,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "buy_order",
                asset: asset,
                quantity: quantity,
                max_price: max_price,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/buy', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })

    }

    exchangeAPI.sell = function (asset, quantity, min_price, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            if (typeof quantity !== "number" || quantity <= 0)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid quantity (${quantity})`, errorCode.INVALID_NUMBER));
            else if (typeof min_price !== "number" || min_price <= 0)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid min_price (${min_price})`, errorCode.INVALID_NUMBER));
            let request = {
                floID: floID,
                asset: asset,
                quantity: quantity,
                min_price: min_price,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "sell_order",
                quantity: quantity,
                asset: asset,
                min_price: min_price,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/sell', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })

    }

    exchangeAPI.cancelOrder = function (type, id, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            if (type !== "buy" && type !== "sell")
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid type (${type}): type should be sell (or) buy`, errorCode.INVALID_TYPE));
            let request = {
                floID: floID,
                orderType: type,
                orderID: id,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "cancel_order",
                order: type,
                id: id,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/cancel', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //receiver should be object eg {floID1: amount1, floID2: amount2 ...}
    exchangeAPI.transferToken = function (receiver, token, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            if (typeof receiver !== 'object' || receiver === null)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid receiver: parameter is not an object", errorCode.INVALID_FLO_ID));
            let invalidIDs = [],
                invalidAmt = [];
            for (let f in receiver) {
                if (!floCrypto.validateAddr(f))
                    invalidIDs.push(f);
                else if (typeof receiver[f] !== "number" || receiver[f] <= 0)
                    invalidAmt.push(receiver[f])
            }
            if (invalidIDs.length)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid receiver (${invalidIDs})`, errorCode.INVALID_FLO_ID));
            else if (invalidAmt.length)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid amount (${invalidAmt})`, errorCode.INVALID_NUMBER));
            let request = {
                floID: floID,
                token: token,
                receiver: receiver,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "transfer_token",
                receiver: JSON.stringify(receiver),
                token: token,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/transfer-token', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.depositFLO = function (quantity, floID, sinkID, privKey, proxySecret = null) {
        return new Promise((resolve, reject) => {
            if (typeof quantity !== "number" || quantity <= floGlobals.fee)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, `Invalid quantity (${quantity})`, errorCode.INVALID_NUMBER));
            else if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            floBlockchainAPI.sendTx(floID, sinkID, quantity, privKey, '(deposit in market)').then(txid => {
                let request = {
                    floID: floID,
                    txid: txid,
                    timestamp: Date.now()
                };
                if (!proxySecret) //Direct signing (without proxy)
                    request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "deposit_flo",
                    txid: txid,
                    timestamp: request.timestamp
                }, proxySecret || privKey);
                console.debug(request);

                fetch_api('/deposit-flo', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.withdrawFLO = function (quantity, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                amount: quantity,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "withdraw_flo",
                amount: quantity,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/withdraw-flo', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.depositToken = function (token, quantity, floID, sinkID, privKey, proxySecret = null) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            floTokenAPI.sendToken(privKey, quantity, sinkID, '(deposit in market)', token).then(txid => {
                let request = {
                    floID: floID,
                    txid: txid,
                    timestamp: Date.now()
                };
                if (!proxySecret) //Direct signing (without proxy)
                    request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "deposit_token",
                    txid: txid,
                    timestamp: request.timestamp
                }, proxySecret || privKey);
                console.debug(request);

                fetch_api('/deposit-token', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.withdrawToken = function (token, quantity, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                token: token,
                amount: quantity,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "withdraw_token",
                token: token,
                amount: quantity,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/withdraw-token', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.getUserTransacts = function (floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "get_transact",
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/get-transact', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.addUserTag = function (tag_user, tag, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                user: tag_user,
                tag: tag,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "add_tag",
                user: tag_user,
                tag: tag,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/add-tag', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.removeUserTag = function (tag_user, tag, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                user: tag_user,
                tag: tag,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "remove_tag",
                user: tag_user,
                tag: tag,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/remove-tag', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.addDistributor = function (distributor, asset, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                distributor: distributor,
                asset: asset,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "add_distributor",
                distributor: distributor,
                asset: asset,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/add-distributor', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.removeDistributor = function (distributor, asset, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                distributor: distributor,
                asset: asset,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "remove_distributor",
                distributor: distributor,
                asset: asset,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/remove-distributor', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.getConvertValues = function () {
        return new Promise((resolve, reject) => {
            fetch_api('/get-convert-values')
                .then(result => {
                    responseParse(result)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error));
        })
    }

    exchangeAPI.convertToBTC = function (amount, floID, sinkID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            floTokenAPI.sendToken(privKey, amount, sinkID, '(convert to BTC)', floGlobals.currency).then(txid => {
                let request = {
                    floID: floID,
                    txid: txid,
                    coin: "BTC",
                    amount: amount,
                    timestamp: Date.now()
                };
                request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "convert_to",
                    coin: request.coin,
                    amount: amount,
                    txid: txid,
                    timestamp: request.timestamp
                }, privKey);
                console.debug(request);

                fetch_api('/convert-to', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.convertFromBTC = function (quantity, floID, sinkID, privKey, fee = null) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            let btc_id = btcOperator.convert.legacy2bech(floID),
                btc_sink = btcOperator.convert.legacy2bech(sinkID);
            btcOperator.createSignedTx(btc_id, privKey, btc_sink, quantity, fee).then(result => {
                let request = {
                    floID: floID,
                    txid: btcOperator.transactionID(result.transaction),
                    tx_hex: result.transaction.serialize(),
                    coin: "BTC",
                    quantity: quantity,
                    timestamp: Date.now()
                };
                request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "convert_from",
                    coin: request.coin,
                    quantity: quantity,
                    txid: request.txid,
                    timestamp: request.timestamp
                }, privKey);
                console.debug(request);

                fetch_api('/convert-from', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.depositConvertFundCurrency = function (amount, floID, sinkID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            floTokenAPI.sendToken(privKey, amount, sinkID, '(add convert fund)', floGlobals.currency).then(txid => {
                let request = {
                    floID: floID,
                    txid: txid,
                    coin: "BTC",
                    timestamp: Date.now()
                };
                request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "deposit_convert_currency_fund",
                    coin: request.coin,
                    txid: txid,
                    timestamp: request.timestamp
                }, privKey);
                console.debug(request);

                fetch_api('/deposit-convert-currency-fund', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.depositConvertFundBTC = function (quantity, floID, sinkID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let btc_id = btcOperator.convert.legacy2bech(floID),
                btc_sink = btcOperator.convert.legacy2bech(sinkID);
            btcOperator.sendTx(btc_id, privKey, btc_sink, quantity, null).then(txid => {
                let request = {
                    floID: floID,
                    txid: txid,
                    coin: "BTC",
                    timestamp: Date.now()
                };
                request.pubKey = floCrypto.getPubKeyHex(privKey);
                request.sign = signRequest({
                    type: "deposit_convert_coin_fund",
                    coin: request.coin,
                    txid: txid,
                    timestamp: request.timestamp
                }, privKey);
                console.debug(request);

                fetch_api('/deposit-convert-coin-fund', {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request)
                }).then(result => {
                    responseParse(result, false)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.withdrawConvertFundCurrency = function (amount, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let request = {
                floID: floID,
                amount: amount,
                coin: "BTC",
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "withdraw_convert_currency_fund",
                coin: request.coin,
                amount: amount,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/withdraw-convert-currency-fund', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.withdrawConvertFundCoin = function (quantity, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let request = {
                floID: floID,
                quantity: quantity,
                coin: "BTC",
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "withdraw_convert_coin_fund",
                coin: request.coin,
                quantity: quantity,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/withdraw-convert-coin-fund', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.closeBlockchainBond = function (bond_id, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            let request = {
                floID: floID,
                bond_id: bond_id,
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "close_blockchain_bond",
                bond_id: request.bond_id,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/close-blockchain-bonds', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.checkBlockchainBond = function (prior_time, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                prior_time,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "check_blockchain_bond",
                prior_time,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/check-blockchain-bond', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.checkBobsFund = function (prior_time, floID, proxySecret) {
        return new Promise((resolve, reject) => {
            let request = {
                floID: floID,
                prior_time,
                timestamp: Date.now()
            };
            if (floCrypto.getFloID(proxySecret) === floID) //Direct signing (without proxy)
                request.pubKey = floCrypto.getPubKeyHex(proxySecret);
            request.sign = signRequest({
                type: "check_bobs_fund",
                prior_time,
                timestamp: request.timestamp
            }, proxySecret);
            console.debug(request);

            fetch_api('/check-bobs-fund', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.closeBobsFundInvestment = function (fund_id, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            let request = {
                floID: floID,
                fund_id: fund_id,
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "close_bobs_fund",
                fund_id: request.fund_id,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/close-bobs-fund-investment', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.generateSink = function (group, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let request = {
                floID: floID,
                group: group,
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "generate_sink",
                group: group,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/generate-sink', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.reshareSink = function (sinkID, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let request = {
                floID: floID,
                id: sinkID,
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "reshare_sink",
                id: sinkID,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/reshare-sink', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    exchangeAPI.discardSink = function (sinkID, floID, privKey) {
        return new Promise((resolve, reject) => {
            if (!floCrypto.verifyPrivKey(privKey, floID))
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Invalid Private Key", errorCode.INVALID_PRIVATE_KEY));
            if (floID !== DEFAULT.marketID)
                return reject(ExchangeError(ExchangeError.BAD_REQUEST_CODE, "Access Denied", errorCode.ACCESS_DENIED));
            let request = {
                floID: floID,
                id: sinkID,
                timestamp: Date.now()
            };
            request.pubKey = floCrypto.getPubKeyHex(privKey);
            request.sign = signRequest({
                type: "discard_sink",
                id: sinkID,
                timestamp: request.timestamp
            }, privKey);
            console.debug(request);

            fetch_api('/discard-sink', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            }).then(result => {
                responseParse(result, false)
                    .then(result => resolve(result))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })

    }

    const _l = key => DEFAULT.marketApp + '-' + key;

    function refreshDataFromBlockchain() {
        return new Promise((resolve, reject) => {
            let nodes, trusted = new Set(), assets, tags, lastTx;
            try {
                nodes = JSON.parse(localStorage.getItem(_l('nodes')));
                trusted = new Set((localStorage.getItem(_l('trusted')) || "").split(','));
                assets = new Set((localStorage.getItem(_l('assets')) || "").split(','));
                tags = new Set((localStorage.getItem(_l('tags')) || "").split(','));
                if (typeof nodes !== 'object' || nodes === null)
                    throw Error('nodes must be an object')
                else
                    lastTx = localStorage.getItem(_l('lastTx'));
            } catch (error) {
                nodes = {};
                trusted = new Set();
                assets = new Set();
                tags = new Set();
            }

            var query_options = { sentOnly: true, pattern: DEFAULT.marketApp };
            if (typeof lastTx == 'string' && /^[0-9a-f]{64}/i.test(lastTx))//lastTx is txid of last tx
                query_options.after = lastTx;
            else if (!isNaN(lastTx))//lastTx is tx count (*backward support)
                query_options.ignoreOld = parseInt(lastTx);
            floBlockchainAPI.readData(DEFAULT.marketID, query_options).then(result => {
                result.data.reverse().forEach(data => {
                    var content = JSON.parse(data)[DEFAULT.marketApp];
                    //Node List
                    if (content.Nodes) {
                        if (content.Nodes.remove)
                            for (let n of content.Nodes.remove)
                                delete nodes[n];
                        if (content.Nodes.add)
                            for (let n in content.Nodes.add)
                                nodes[n] = content.Nodes.add[n];
                        if (content.Nodes.update)
                            for (let n in content.Nodes.update)
                                nodes[n] = content.Nodes.update[n];
                    }
                    //Trusted List
                    if (content.Trusted) {
                        if (content.Trusted.remove)
                            for (let id of content.Trusted.remove)
                                trusted.delete(id);
                        if (content.Trusted.add)
                            for (let id of content.Trusted.add)
                                trusted.add(id);
                    }
                    //Asset List
                    if (content.Assets) {
                        for (let a in content.Assets)
                            assets.add(a);
                    }
                    //Tag List
                    if (content.Tag) {
                        if (content.Tag.remove)
                            for (let t of content.Tag.remove)
                                tags.delete(t);
                        if (content.Tag.add)
                            for (let t in content.Tag.add)
                                tags.add(t);
                    }
                });
                localStorage.setItem(_l('lastTx'), result.lastItem);
                localStorage.setItem(_l('nodes'), JSON.stringify(nodes));
                localStorage.setItem(_l('trusted'), Array.from(trusted).join(","));
                localStorage.setItem(_l('assets'), Array.from(assets).join(","));
                localStorage.setItem(_l('tags'), Array.from(tags).join(","));
                nodeURL = nodes;
                nodeKBucket = new K_Bucket(DEFAULT.marketID, Object.keys(nodeURL));
                nodeList = nodeKBucket.order;
                resolve(nodes);
            }).catch(error => reject(error));
        })
    }

    exchangeAPI.init = function (service = serviceList.EXCHANGE) {
        return new Promise((resolve, reject) => {
            refreshDataFromBlockchain().then(nodes => {
                getSink(service)
                    .then(sinkID => floCrypto.validateAddr(sinkID) ? _sinkID = sinkID : undefined)
                    .catch(error => console.warn("Unable to fetch sinkID", error))
                    .finally(_ => resolve(nodes))
            }).catch(error => reject(error))
        })
    }

    const config = exchangeAPI.config = {
        get trustedList() {
            return new Set((localStorage.getItem(_l('trusted')) || "").split(','));
        },
        get assetList() {
            return new Set((localStorage.getItem(_l('assets')) || "").split(','));
        },
        get tagList() {
            return new Set((localStorage.getItem(_l('tags')) || "").split(','));
        }
    }

    exchangeAPI.clearAllLocalData = function () {
        localStorage.removeItem(_l('nodes'));
        localStorage.removeItem(_l('trusted'));
        localStorage.removeItem(_l('assets'));
        localStorage.removeItem(_l('tags'));
        localStorage.removeItem(_l('lastTx'));
        localStorage.removeItem(_l('proxy_secret'));
        localStorage.removeItem(_l('user_ID'));
        location.reload();
    }

    //container for user ID and proxy private-key
    var _userID, _publicKey, _privateKey, _sinkID;
    const proxy = exchangeAPI.proxy = {
        async lock() {
            if (!_privateKey)
                return notify("No proxy key found!", 'error');
            getPromptInput("Add password", 'This password applies to this browser only!', {
                isPassword: true,
                confirmText: "Add password"
            }).then(pwd => {
                if (!pwd)
                    notify("Password cannot be empty", 'error');
                else if (pwd.length < 4)
                    notify("Password minimum length is 4", 'error');
                else {
                    let tmp = Crypto.AES.encrypt(_privateKey, pwd);
                    localStorage.setItem(_l('proxy_secret'), "?" + tmp);
                    notify("Successfully locked with Password", 'success');
                }
            }).catch(_ => null);
        },
        clear() {
            localStorage.removeItem(_l('proxy_secret'));
            localStorage.removeItem(_l('user_ID'));
            _userID = null;
            _privateKey = null;
            _publicKey = null;
        },
        get sinkID() {
            return _sinkID;
        },
        set userID(id) {
            localStorage.setItem(_l('user_ID'), id);
            _userID = id;
        },
        get userID() {
            if (_userID)
                return _userID;
            else {
                let id = localStorage.getItem(_l('user_ID'));
                return id ? _userID = id : undefined;
            }
        },
        get user() {
            return this.userID;
        },
        set secret(key) {
            localStorage.setItem(_l('proxy_secret'), key);
            _privateKey = key;
            _publicKey = floCrypto.getPubKeyHex(key);
        },
        get secret() {
            return new Promise((resolve, reject) => {
                if (_privateKey)
                    return resolve(_privateKey);

                const Reject = reason => {
                    notify(reason, 'error');
                    reject(reason);
                }
                const setValues = priv => {
                    try {
                        _privateKey = priv;
                        _publicKey = floCrypto.getPubKeyHex(priv);
                        resolve(_privateKey);
                    } catch (error) {
                        Reject("Unable to fetch Proxy secret");
                    }
                };
                let tmp = localStorage.getItem(_l('proxy_secret'));
                if (typeof tmp !== "string")
                    Reject("Unable to fetch Proxy secret");
                else if (tmp.startsWith("?")) {
                    getPromptInput("Enter password", '', {
                        isPassword: true
                    }).then(pwd => {
                        if (!pwd)
                            return Reject("Password Required for making transactions");
                        try {
                            tmp = Crypto.AES.decrypt(tmp.substring(1), pwd);
                            setValues(tmp);
                        } catch (error) {
                            Reject("Incorrect Password! Password Required for making transactions");

                        }
                    }).catch(_ => Reject("Password Required for making transactions"));
                } else
                    setValues(tmp);
            })
        }
    }

})('object' === typeof module ? module.exports : window.floExchangeAPI = {});