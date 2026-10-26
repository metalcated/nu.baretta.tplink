'use strict';

//debug
//process.env.DEBUG = 'tplink-smarthome-api*';

// need Homey module, see SDK Guidelines
const Homey = require('homey');

const { Client } = require('tplink-smarthome-api');

const client = new Client({
    //    logLevel: 'debug' // Set the log level to 'debug' for detailed logs
});


// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}
var TPlinkModel = getDriverName().toUpperCase();
var myRegEx = new RegExp(TPlinkModel, 'g');

var logEvent = function (eventName, plug) {
    console.log(`${(new Date()).toISOString()} ${eventName} ${plug.model} ${plug.host} ${plug.deviceId}`);
};

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

class TPlinkPlugDriver extends Homey.Driver {


    async onPair(session) {
        // socket is a direct channel to the front-end
        var devIds = {};

        try {
            let apidevices = this.getDevices();
            Object.values(apidevices).forEach(device => {
                let deviceId = device.getData().id;
                devIds[deviceId] = "";
                this.log("Found already pairded device with ID: " + deviceId);
            });
            if (Object.keys(devIds).length === 0) {
                this.log("No existing devices found.");
            }
        } catch (err) {
            this.log("Error: ", err);
        }

        var id = guid();
        let devices = [{
            "data": {
                "id": id
            },
            "name": "initial_name",
            "settings": {
                "settingIPAddress": "0.0.0.0",
                "totalOffset": 0
            } // initial settings
        }];

        // discover function
        session.setHandler("discover", async (data) => {

            let discoveredDevicesArray = []; // Initialize an array to store discovered devices

            if (Array.isArray(data) && data.length > 0 && data[0].ip && data[0].ip !== '') {

                var discoveryOptions = {
                    deviceTypes: 'plug',
                    discoveryInterval: 1500,
                    discoveryTimeout: 3000,
                    breakoutChildren: true,
                    devices: [{ host: data[0].ip }]  // Setting the 'devices' property
                };
            } else {
                // If data[0].ip is not defined
                var discoveryOptions = {
                    deviceTypes: 'plug',
                    discoveryInterval: 1500,
                    discoveryTimeout: 3000,
                    breakoutChildren: true
                };
            }

            this.log('Starting Plug Discovery with options...' + JSON.stringify(discoveryOptions));

            client.startDiscovery(discoveryOptions);

            try {

                client.on('plug-new', async (plug) => {
                    logEvent('Found plug-new type', plug);
                    // const sysInfo = await plug.getSysInfo();
                    if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId) && !devIds.hasOwnProperty(plug.childId)) {

                        // if (sysInfo.children) {
                        const childrenMap = plug.children; // Get the map of children
                        childrenMap.forEach((child, childId) => {
                            const childName = child.alias || `Socket${childId}`;

                            if (!discoveredDevicesArray.some(device => device.childId === childId)) {
                                this.log("New Sub-socket found: " + childName + " in " + plug.host + " id " + childId);
                                discoveredDevicesArray.push({
                                    ip: plug.host,
                                    name: childName,
                                    deviceId: plug.deviceId,
                                    childId: childId
                                });

                            }

                        });
                        //} 

                    }

                });

            } catch (error) {
                this.log('Error in discovery process:', error);
            }


            try {
                client.on('plug-online', async (plug) => {
                    logEvent('Found plug-online type', plug);


                    if (Array.isArray(data) && data.length > 0 && data[0].ip && data[0].ip !== '') {

                        const userEnteredIp = data[0].ip; // Assuming this is the user-entered IP address

                        if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId) && !devIds.hasOwnProperty(plug.childId) && plug.host === userEnteredIp) {


                            let deviceName = plug.alias || `Device ${plug.deviceId}`;
                            let childId = plug.childId || null; // null for non-child devices

                            if (!discoveredDevicesArray.some(device => device.deviceId === plug.deviceId && device.childId === childId)) {
                                if (plug.host === userEnteredIp) {
                                    this.log(`New Socket found online (discovery): ${deviceName} in ${plug.host} with Device ID: ${plug.deviceId} and Child ID: ${childId}`);
                                    discoveredDevicesArray.push({
                                        ip: plug.host,
                                        name: deviceName,
                                        deviceId: plug.deviceId,
                                        childId: childId
                                    });

                                }

                            }
                        }

                    } // If data[0].ip is not defined
                    else if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId) && !devIds.hasOwnProperty(plug.childId)) {

                        let deviceName = plug.alias || `Device ${plug.deviceId}`;
                        let childId = plug.childId || null; // null for non-child devices

                        if (!discoveredDevicesArray.some(device => device.deviceId === plug.deviceId && device.childId === childId)) {

                            this.log(`Socket found online (manual IP): ${deviceName} in ${plug.host} with Device ID: ${plug.deviceId} and Child ID: ${childId}`);
                            discoveredDevicesArray.push({
                                ip: plug.host,
                                name: deviceName,
                                deviceId: plug.deviceId,
                                childId: childId
                            });

                        }

                    }
                });

            } catch (error) {
                this.log('Error in plug-online process:', error);
            }


setTimeout(() => {
  client.stopDiscovery(); // Stop discovery after timeout

  if (discoveredDevicesArray.length > 0) {
    session.emit("discovered_devices", discoveredDevicesArray);
    this.log("Discovered devices: " + JSON.stringify(discoveredDevicesArray));
    return discoveredDevicesArray;
  } else {
    this.log("No devices discovered");
    session.emit("discovery_failed", { devicesFound: false });
    return [];
  }
}, discoveryOptions.discoveryTimeout);
});



        // this is called when the user presses "Next to select" button in start.html
        session.setHandler("get_devices", async (data) => {
            this.log("Received get_devices data: " + JSON.stringify(data));

            try {
                this.log("Processing device(s) from autodiscovery");
                // Handle normally for autodiscovered devices
                let inputData = Array.isArray(data) ? data : [data];

                let devices = inputData
                    .filter(device => device.childId) // Filter to include only devices with a childId
                    .map(device => {
                        let deviceId = guid();
                        return {
                            data: { id: device.deviceId, childId: device.childId },
                            name: device.name,
                            settings: {
                                "settingIPAddress": device.ip,
                                "dynamicIp": false,
                                "totalOffset": 0
                            }
                        };
                    });

                // Log and return the processed devices
                this.log("Processed devices: " + JSON.stringify(devices));


                // Set passed pair settings in variables
                //this.log("Got get_devices from front-end, IP =", data.ipaddress, " Name = ", data.deviceName);
                session.emit('continue', null);

                // this method is run when Homey.emit('list_devices') is run on the front-end
                // which happens when you use the template `list_devices`

                session.setHandler("list_devices", async (data) => {
                    //this.log("List_devices data: " + JSON.stringify(data));
                    return devices;
                });

            } catch (error) {
                this.log('Error in discovery process:', error);
            }


        });

        session.setHandler("cancel", () => {
            this.log("Pairing cancelled, state reset.");
            client.stopDiscovery();
        });

        session.setHandler("disconnect", () => {
            this.log("Pairing is finished (done or aborted)");
            client.stopDiscovery();
        })
    }
}

module.exports = TPlinkPlugDriver;
