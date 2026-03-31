# Homebridge HCPBridgeMqtt

A simple plugin that subscribes to one MQTT subject - the state subject that describes the status of the garage door:
- open
- closed
- opening 
- closing
- error
- problem
- venting

One trigger value is published to the 'Set Topic' when the motor should be engaged to open or close.