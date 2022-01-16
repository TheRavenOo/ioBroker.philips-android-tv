"use strict";
const util = require('util');
const utils = require("@iobroker/adapter-core");
const request = require("request");
const CryptoJS = require("crypto-js");
const wol = require('wake_on_lan');

const adapterName = require("./package.json").name.split(".").pop();
const delay = ms => new Promise(res => setTimeout(res, ms));

const secret_key = 'JCqdN5AcnAHgJYseUn7ER5k3qgtemfUvMRghQpTfTZq7Cvv8EPQPqfz6dDxPQPSu4gKFPWkJGw32zyASgJkHwCjU';

class PhilipsAndroidTVAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: adapterName });

        //this._api = new apiClass();
        //this._api.eventRaised = this._eventRaised.bind(this);
        //this._api.dataReceived = this._dataReceived.bind(this);
        //this._api.opened = this._opened.bind(this);
        //this._api.closed = this._closed.bind(this);
        //this._api.errored = this._errored.bind(this);
        //this._api.requestError = this._requestError.bind(this);
        //this._api.unexpectedResponse = this._unexpectedResponse.bind(this);

        this.on("unload", this._unload);
        this.on("objectChange", this._objectChange);
        this.on("stateChange", this._stateChange);
        this.on("message", this._message);
        this.on("ready", this._ready);

        this._unloaded = false;
		this._pairingProcessState = { state: "idle" };

		this._authorization_timestamp = "";
		this._onscreen_password = "";
		
		this._authorization = { };
		
		this._available_commands = require("./available_commands.json");

		//console.log(this._available_commands); 

        //this.wsConnected = false;
        //this.wsConnectionStableTimeout = null;
        //this.wsConnectionErrorCounter = 0;

        //this.sendUnknownInfos = {};

        //this.currentValues = {};
        this.delayTimeouts = {};
        //this.initializedChannels = {};
        //this.reInitDataTimeout = null;						
    }
	
	async _createObjects() {
        let promises = [];
		
		promises.push(this.extendObjectAsync("info", { type: "channel", common: { }, native: {} }));
		promises.push(this.extendObjectAsync("info.connection", { type: "state", common: { name: "If connected to Cloud", type: "boolean", "role": "indicator.connected", "read": true, "write": false, "def": false }, native: {} }));
		
		let group_names = Object.keys(this._available_commands);
		for (let i = 0; i < group_names.length; i++) {
			promises.push(this.extendObjectAsync(group_names[i], { type: "channel", common: { }, native: {} }));
			
			let function_names = Object.keys(this._available_commands[group_names[i]]);
			for (let j = 0; j < function_names.length; j++) {
				let function_attributes = this._available_commands[group_names[i]][function_names[j]]["attributes"];
				if (function_attributes["type"] == "button")
					promises.push(this.extendObjectAsync(group_names[i] + "." + function_names[j], { type: "state", common: { name: function_names[j], type: "boolean", "role": "button", "read": function_attributes["readable"], "write": function_attributes["writeable"] }, native: {} }));
				else if (function_attributes["type"] == "boolean")
					promises.push(this.extendObjectAsync(group_names[i] + "." + function_names[j], { type: "state", common: { name: function_names[j], type: "boolean", "role": "", "read": function_attributes["readable"], "write": function_attributes["writeable"], "def": false }, native: {} }));
				else if (function_attributes["type"] == "number")
					promises.push(this.extendObjectAsync(group_names[i] + "." + function_names[j], { type: "state", common: { name: function_names[j], type: "number", "role": "value", "read": function_attributes["readable"], "write": function_attributes["writeable"], "def": 0 }, native: {} }));
				else if (function_attributes["type"] == "string")
					promises.push(this.extendObjectAsync(group_names[i] + "." + function_names[j], { type: "state", common: { name: function_names[j], type: "string", "role": "text", "read": function_attributes["readable"], "write": function_attributes["writeable"] }, native: {} }));
				else
					this.log.error("Function '" + function_names[j] + "': unknown function type '" + function_attributes["type"] + "'");
			}
		}
		
		return Promise.all(promises);
	}
	
    _unload(callback) {
        this._unloaded = true;
        //this.reInitTimeout && clearTimeout(this.reInitTimeout);
       // this.reInitDataTimeout && clearTimeout(this.reInitDataTimeout);
        try {
            this.log.info("cleaned everything up...");
            callback();
        } catch (e) {
            callback();
        }
    }

    _objectChange(id, obj) {
        this.log.info("objectChange " + id + " " + JSON.stringify(obj));
    }
	
	round(value, step) {
        step = step || 1.0;
        const inv = 1.0 / step;
        return Math.round(value * inv) / inv;
    }
	
    async _doStateChange(id, o, state) {
		let error_count = 0;
		let max_error_count = 5;
		while (error_count++ < max_error_count) {
			try {
				let name = o["_id"].split(".");
				let group_name = name[2];
				let function_name = name[3];
				
				let command = this._available_commands[group_name][function_name];
				if (!command["attributes"]["writeable"])
					return;
				
				let url = this.config.protocol + this.config.host + ":" + this.config.port + "/" + this.config.api_version + "/" + command["path"];
				
				if (group_name == "general" && function_name == "volume") {
					let body = command["body"];
					body["current"] = state.val;
					await this.doRequestAuth(url, "POST", JSON.stringify(body), this._authorization);
					return;
				} else if (group_name == "general" && function_name == "powerstate") {
					try {
						await this.doRequestAuth(url, "POST", JSON.stringify(command["body"][state.val ? 1 : 0]), this._authorization);
					} catch (error) {
						if (this.config.mac.length > 0 && state.val) {
							wol.wake(this.config.mac, function(error) {
								this.log.info("WOL");
								if (error) {
									this.log.error(error);
								} else {
									this.log.info("done!");
								}
							});
						}
					}
					return;
				} else if (command["attributes"]["type"] == "button") {
					await this.doRequestAuth(url, "POST", JSON.stringify(command["body"]), this._authorization);
					return;
				} 
				else if (command["attributes"]["type"] == "boolean") {
					await this.doRequestAuth(url, "POST", JSON.stringify(command["body"][state.val ? 1 : 0]), this._authorization);
					return;
				} 
				else {
					this.log.error("unknown writeable command type: " + command["attributes"]["type"]);
					return;
				} 
			} catch (error) {
				if (error) {
					console.error(error);
					this.log.warn(`${o["_id"]} - state change error: ${error}`);
				}
			}
		}
    }
	
    async _stateChange(id, state) {
        if (!id || !state || state.ack || this._unloaded) return;

        let o = await this.getObjectAsync(id);
        if (o) {
			// if running timeout and not debounce, requests come in too fast
			if (this.delayTimeouts[id] && this.delayTimeouts[id].timeout) {
				this.log.info(`${o["_id"]} - Too fast value changes, change blocked!`);
				return;
			}
          
            this.delayTimeouts[id] = this.delayTimeouts[id] || {};
            // clear timeout if one is running
            if (this.delayTimeouts[id].timeout) {
                clearTimeout(this.delayTimeouts[id].timeout);
                delete this.delayTimeouts[id].timeout;
            }

			this.delayTimeouts[id].timeout = setTimeout(() => {
				this.delayTimeouts[id].timeout = null;
			}, o.native.throttle || 1000)
			await this._doStateChange(id, o, state)
        }
    }
	
    async _message(msg) {
        switch (msg.command) {
            case "pairingProcessState":
                this.sendTo(msg.from, msg.command, this._pairingProcessState, msg.callback);
                break;

            case "startPairingProcess":
                this._pairingProcessState = { state: "pairingProcessStarted" };
                this.sendTo(msg.from, msg.command, this._pairingProcessState, msg.callback);

				let api_version = await this.find_api_version();
				if (!api_version) {
					this.log.error("Could not connect to TV!");
					this._pairingProcessState = { state: "errorOccured" };
					return;
				}
				
				this.log.info("Starting pairing process...");
				await this.request_pairing();
                break;
				
			case "finishPairingProcess":
				this.log.info("Finishing pairing process...");
				this._onscreen_password = msg.message;
				await this.finish_pairing();
				break;
        }
    }
	
	async _updateLoop() {
        try {
			let group_names = Object.keys(this._available_commands);
			for (let i = 0; i < group_names.length; i++) {
				let function_names = Object.keys(this._available_commands[group_names[i]]);
				for (let j = 0; j < function_names.length; j++) {
					let command = this._available_commands[group_names[i]][function_names[j]];
					if (!command["attributes"]["readable"])
						continue;
					
					let url = this.config.protocol + this.config.host + ":" + this.config.port + "/" + this.config.api_version + "/" + command["path"];
					let result = await this.doRequestAuth(url, "GET", "", this._authorization);
					let response = JSON.parse(result);
					if (response) {	
						if (group_names[i] == "general" && function_names[j] == "volume") {
							await this.setStateAsync(group_names[i] + "." + function_names[j], response["current"], true);
						} else if (group_names[i] == "general" && function_names[j] == "list_applications") {
							//console.error(console.log(util.inspect(response, false, null, true /* enable colors */)));
						} else if (group_names[i] == "general" && function_names[j] == "current_app") {
							console.error(result);
						} else if (group_names[i] == "general" && function_names[j] == "current_channel") {
							await this.setStateAsync(group_names[i] + "." + function_names[j], response["channel"]["name"], true);
						} else if (command["attributes"]["type"] == "boolean") {
							let body_name = Object.keys(this._available_commands[group_names[i]][function_names[j]]["body"][0]);
							await this.setStateAsync(group_names[i] + "." + function_names[j], response[body_name[0]] == command["body"][1][body_name[0]], true);
						} else
							this.log.error("unknown readable command: " + group_names[i] + "." + function_names[j] + " with type '" + command["attributes"]["type"] + "'");
					}
				}
			}
        } catch (error) {
			if (error)
				console.error(error);
        }
		
		setTimeout(() => this._updateLoop(), 5000);
	}
	
    async _ready() {
        this.log.debug("ready");
        this.setState("info.connection", false, true);
		
		if (!this.config || !this.config.host || this.config.host.length == 0) {
			this.log.error("Please set the hostname/ip in the adapter options before starting the adapter!");
			this.stop();
			return;
		}
		
		if (this.config.device_id && this.config.device_id.length > 0 && this.config.password && this.config.password.length > 0) {
			this._authorization = {
				user: this.config.device_id,
				pass: this.config.password,
				sendImmediately: false,
			};
			
			await this._createObjects();
			this.log.debug("subscribeStates");
			this.subscribeStates("*");

			this.setState("info.connection", true, true);
			this.log.info(adapterName + " adapter connected and ready");
			
			this._updateLoop();
		}
	}
	
	doRequest(url, method, body = "") {
		return new Promise(function (resolve, reject) {
			const payload = {
				url: url,
				method: method,
				body: body,
				rejectUnauthorized: false,
				timeout: 5000,
				forever: true,
				followAllRedirects: true
			};
			
			request(payload, function (error, res, body) {
				if (!error && res.statusCode == 200) {
					resolve(body);
				} else if (error) {
					reject(error);
				} else
					reject(res);
			});
		});
	}
	
	doRequestAuth(url, method, body = "", authorization) {
		return new Promise(function (resolve, reject) {
			const payload = {
				url: url,
				method: method,
				body: body,
				rejectUnauthorized: false,
				timeout: 5000,
				forever: true,
				followAllRedirects: true,
				auth: authorization
			};
			
			request(payload, function (error, res, body) {
				if (!error && res.statusCode == 200) {
					resolve(body);
				} else if (error) {
					reject(error);
				} else
					reject(res);
			});
		});
	}

	async find_api_version(possible_ports = [1925], possible_api_versions = [6, 5, 1]) {
		this.log.info("Checking API version and port...");
		let protocol = "http://";
		let result_api = 0;
		
		for (let port in possible_ports) {
			for (let api_version in possible_api_versions) {
				let url = protocol + this.config.host + ":" + possible_ports[port] + "/" + possible_api_versions[api_version] + "/system";
				this.log.info("Trying " + url);
				
				let error_count = 0;
				let max_error_count = 10;
				while (error_count++ < max_error_count) {
					try {
						let result = await this.doRequest(url, "GET");
						let response = JSON.parse(result);
						if (response) {
							if ("api_version" in response && "Major" in response["api_version"] && possible_api_versions.includes(response["api_version"]["Major"])) {
								if (result_api > response["api_version"]["Major"].toString())
									return;
								
								result_api = this.config.api_version = response["api_version"]["Major"].toString();
								this.log.info("TV is using API Version: " + this.config.api_version);
							}
							else
							{
								this.log.warning("Could not find a valid API version! Adapter will try to use API version '" + response["api_version"]["Major"] + "'");
								result_api = this.config.api_version = possible_api_versions[api_version];
							}
							
							if ("featuring" in response && "systemfeatures" in response["featuring"] && "pairing_type" in response["featuring"]["systemfeatures"] && response["featuring"]["systemfeatures"]["pairing_type"] == "digest_auth_pairing") {
								this.config.protocol = "https://";
								this.config.port = "1926";
							} else {
								this.config.protocol = "http://";
								this.config.port = "1925";
							}	
							
							return result_api;
						}
					} catch (error) {
						if (error)
							console.error(error);
					}
				}
			}
		}
		
		return result_api;
	}

	async request_pairing() {
		this.config.device_id = "";
		
		let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		for (let i = 0; i < 16; i++)
			this.config.device_id += characters.charAt(Math.floor(Math.random() * characters.length));
			
		let device_spec = { "device_name" : "heliotrope", "device_os" : "Android", "app_name" : "philips-tv", "type" : "native", "app_id": "app.id", "id": this.config.device_id };
		let data = { "application_id": "app.id", "device_id":  this.config.device_id, "scope": ["read", "write", "control"], "device": device_spec };
		
		let url = this.config.protocol + this.config.host + ":" + this.config.port + "/" + this.config.api_version + "/pair/request";
		this.log.info("Sending pairing request to '" + url + "'");
		
		try {
			let result = await this.doRequest(url, "POST", JSON.stringify(data));
			let response = JSON.parse(result);
			if (response) {
				if ("error_id" in response) {
					if (response["error_id"] == "SUCCESS") {
						this._authorization_timestamp = response["timestamp"];
						this.config.password = response["auth_key"];
						
						this._authorization = {
							user: this.config.device_id,
							pass: this.config.password,
							sendImmediately: false,
						};
							
						let timeout = 60;
						while (timeout > 0) {
							if (this._onscreen_password.length > 0)
								return;
							
							this._pairingProcessState = { state: "pairingProcessWaitingForOnscreenPasscode", timeout: timeout };
							await delay(1000);
							timeout--;
						}
						
						this._pairingProcessState = { state: "errorOccured" };						
					} else
						this._pairingProcessState = { state: "errorOccured" };
				} else
					this._pairingProcessState = { state: "errorOccured" };
			}
		} catch (error) {
			this._pairingProcessState = { state: "errorOccured" };
			
			if (error)
				console.error(error);
		}
	}
	
	create_pairing_payload() {
		let hmac = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA1, Buffer.from(secret_key, "base64").toString()); 
		hmac.update(this._authorization_timestamp.toString() + this._onscreen_password.toString());
		let authorization_signature = Buffer.from("" + hmac.finalize()).toString("base64");   

		let auth = { "pin": this._onscreen_password, "auth_timestamp": this._authorization_timestamp, "auth_signature": authorization_signature};
		let device_spec = { "device_name" : "heliotrope", "device_os" : "Android", "app_name" : "philips-tv", "type" : "native", "app_id": "app.id", "id": this.config.device_id, "auth_key": this.config.password };		
		let data = { "auth": auth, "device": device_spec };
		
		return data;
	}
	
	async finish_pairing() {
		let pairing_payload = this.create_pairing_payload();
		console.debug("Pairing payload: \n" + pairing_payload);

		let url = this.config.protocol + this.config.host + ":" + this.config.port + "/" + this.config.api_version + "/pair/grant";
		this.log.info("Sending pairing confirmation to '" + url + "'");
		
		try {
			let response = await this.doRequestAuth(url, "POST", JSON.stringify(pairing_payload), this._authorization);
			this._pairingProcessState = { state: "pairingSuccessful" , device_id: this.config.device_id, password: this.config.password, port: this.config.port, api_version: this.config.api_version, protocol: this.config.protocol };
		} catch (error) {
			this._pairingProcessState = { state: "errorOccured" };
			if (error)
				console.error(error);
		}
	}
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = (options) => new PhilipsAndroidTVAdapter(options);
} else {
    // or start the instance directly
    new PhilipsAndroidTVAdapter();
}