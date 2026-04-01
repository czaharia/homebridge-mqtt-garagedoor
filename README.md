# Homebridge HCPBridgeMQTT

A simple Homebridge plugin that subscribes HCPBridgeMQTT (https://github.com/Gifford47/HCPBridgeMqtt) topic and controls the garage door.
The state subject that describes the status of the garage door:
- open
- closed
- opening 
- closing
- error
- problem
- venting

One trigger value is published to the 'Set Topic' when the motor should be engaged to open or close.