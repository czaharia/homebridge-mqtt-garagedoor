export interface HCPDiscovery {
  hostname: string;
  ipAddress: string;
  lampDiscovered: boolean;
  ventDiscovered: boolean;
  doorStateTopic: string;
  doorCommandTopic: string;
  doorPayloadOpen: string;
  doorPayloadClose: string;
  doorPayloadStop: string;
  lampCommandTopic: string;
  lampPayloadOn: string;
  lampPayloadOff: string;
  ventCommandTopic: string;
  ventPayloadOn: string;
  ventPayloadOff: string;
  availabilityTopic: string;
  payloadAvailable: string;
  payloadNotAvailable: string;
  manufacturer: string;
  model: string;
  swVersion: string;
}

export const defaultDiscovery: HCPDiscovery = {
  hostname: 'hcpbridge',
  ipAddress: '',
  lampDiscovered: false,
  ventDiscovered: false,
  doorStateTopic: 'hormann/hcpbridge/state',
  doorCommandTopic: 'hormann/hcpbridge/command/door',
  doorPayloadOpen: 'open',
  doorPayloadClose: 'close',
  doorPayloadStop: 'stop',
  lampCommandTopic: 'hormann/hcpbridge/command/lamp',
  lampPayloadOn: 'true',
  lampPayloadOff: 'false',
  ventCommandTopic: 'hormann/hcpbridge/command/vent',
  ventPayloadOn: 'venting',
  ventPayloadOff: 'close',
  availabilityTopic: 'hormann/hcpbridge/availability',
  payloadAvailable: 'online',
  payloadNotAvailable: 'offline',
  manufacturer: 'Hormann',
  model: 'Garage Door',
  swVersion: 'unknown',
};
