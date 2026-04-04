import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge';
import { GarageDoorOpenerPlatform } from './platform.js';
import { GarageState } from './garagestate.js';

export class GarageDoorOpenerAccessory {
  private service: Service;
  private garageState: GarageState;
  private lampService: Service | null = null;
  private ventService: Service | null = null;
  
  constructor(
        private readonly platform: GarageDoorOpenerPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly state: GarageState | null = null,
		
  ) {
    
    this.platform.log.debug('constructing GarageDoorOpenerAccessory...');
    
    this.garageState = state ?? new GarageState(this.platform.api, this.platform.log);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'RFx Software Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'GDC-1')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '100001');

    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
        || this.accessory.addService(this.platform.Service.GarageDoorOpener);

    if (this.platform.isLampEnabled()) {
      this.lampService = this.accessory.getService(this.platform.Service.Lightbulb)
        || this.accessory.addService(this.platform.Service.Lightbulb, 'Garage Lamp');

      this.lampService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLampState.bind(this))
        .onGet(this.getLampState.bind(this));

      this.platform.log.debug('Lamp service initialized');
    }
	
    if (this.platform.isVentEnabled()) {
      this.ventService = this.accessory.getService(this.platform.Service.Switch)
        || this.accessory.addService(this.platform.Service.Switch, 'Garage Vent');

      this.ventService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setVentState.bind(this))
        .onGet(this.getVentState.bind(this));

      this.platform.log.debug('Vent switch service initialized');
    }

    const tds = this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState);
    tds
      .onSet(this.setTargetDoorState.bind(this))
      .onGet(this.getTargetDoorState.bind(this));

    const cds = this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState);
    cds
      .onGet(this.getCurrentDoorState.bind(this));


    this.garageState.on('current', (currentValue) => {
      this.platform.log.debug('emitted [current] value: ', currentValue);
      if (currentValue >= 0 && currentValue < 5) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.currentDoorStateCharacteristic().updateValue(currentValue);
      } else {
        this.platform.log.warn('ignoring current value update: ', currentValue);
      }
    });

    this.garageState.on('target', (targetValue) => {
      this.platform.log.debug('emitted [target] value: ', targetValue);
      if (targetValue >= 0 && targetValue < 2) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.targetDoorStateCharacteristic()?.updateValue(targetValue);
      }else {
        this.platform.log.warn('ignoring target value update: ', targetValue);
      }
    });

    this.platform.log.debug('initial door states: ', this.garageState.description());
  }

  private lampOn = false;
  
  setLampState(value: CharacteristicValue) {
    this.lampOn = value as boolean;
    this.platform.log.debug('Set lamp state ->', this.lampOn);
    this.platform.publishLampCommand(this.lampOn);
  }

  getLampState(): CharacteristicValue {
    if (!this.platform.getIsOnline()) {
      throw this.notReadyError();
    }
    return this.lampOn;
  }

  updateLampState(value: boolean) {
    if (this.lampService === null) {
      return; // lamp not enabled, ignore
    }
    this.lampOn = value;
    this.lampService.getCharacteristic(this.platform.Characteristic.On).updateValue(value);
    this.platform.log.debug('Updated lamp state ->', value);
  }
  
  private notReadyError() {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  currentDoorStateCharacteristic(): Characteristic {
    return this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState);
  }

  targetDoorStateCharacteristic(): Characteristic {
    return this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState);
  }

  handleLogUpdate(value: string) {
    this.platform.log.info('log update: ', value);
  }
  
  updateCurrentDoorState(value: number) {
    this.garageState.updateCurrentState(value);
    this.currentDoorStateCharacteristic().updateValue(value);
    this.platform.log.debug('Update CurrentDoorState ->', this.garageState.description());
  }
  
  updateTargetDoorStateWithoutPublishing(value: CharacteristicValue) {
    this.garageState.updateTargetState(value as number);
    this.targetDoorStateCharacteristic()?.updateValue(value);
    this.platform.log.debug('Update TargetDoorState ->', this.garageState.description());
  }

  setTargetDoorState(value: CharacteristicValue) {
    const currentState = this.garageState.getCurrentState();
    const isMoving = currentState === this.platform.Characteristic.CurrentDoorState.OPENING || 
	  currentState === this.platform.Characteristic.CurrentDoorState.CLOSING;
    if (isMoving) {
      this.platform.log.debug('Door is moving, sending stop command');
      this.platform.publishStopCommand();
      const previousTarget = this.garageState.getTargetState();
      this.targetDoorStateCharacteristic()?.updateValue(previousTarget);
      return;
    }
    this.garageState.updateTargetState(value as number);
    this.platform.log.debug('Set TargetDoorState ->', this.garageState.description());
    this.platform.publishTargetDoorState(value as number);
  }

  getTargetDoorState(): CharacteristicValue {
    if (!this.platform.getIsOnline()) { 
      throw this.notReadyError(); 
    }
    const state = this.garageState.getTargetState();
    return state < 0 ? this.platform.Characteristic.TargetDoorState.CLOSED : state;
  }

  getCurrentDoorState(): CharacteristicValue {
    if (!this.platform.getIsOnline()) { 
      throw this.notReadyError(); 
    }
    const state = this.garageState.getCurrentState();
    return state < 0 ? this.platform.Characteristic.CurrentDoorState.CLOSED : state;
  }
  
  setVentState(value: CharacteristicValue) {
    const turnOn = value as boolean;

    if (turnOn) {
      // only send vent command if door is currently closed
      const currentState = this.garageState.getCurrentState();
      const isClosed = currentState === this.platform.Characteristic.CurrentDoorState.CLOSED;
      if (isClosed) {
        this.platform.log.debug('Sending vent command (door is closed)');
        this.platform.publishVentCommand();
      } else {
        this.platform.log.warn('Vent command ignored: door is not closed (state: ', currentState, ')');
        // revert switch back to off — door is not in a state where vent makes sense
        setTimeout(() => {
          this.ventService?.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        }, 500);
      }
    } else {
      // only send close command if currently venting
      if (this.platform.isCurrentlyVenting()) {
        this.platform.log.debug('Sending close command (was venting)');
        this.platform.publishTargetDoorState(this.platform.Characteristic.TargetDoorState.CLOSED);
      } else {
        this.platform.log.warn('Close from vent ignored: door is not venting');
      }
    }
  }

  getVentState(): CharacteristicValue {
    if (!this.platform.getIsOnline()) {
      throw this.notReadyError();
    }
    return this.platform.isCurrentlyVenting();
  }
  
  updateVentState(value: boolean) {
    if (this.ventService === null) {
      return;
    }
    this.ventService
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(value);
    this.platform.log.debug('Updated vent state ->', value);
  }
  
}