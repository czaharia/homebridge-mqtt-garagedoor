import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge';
import { GarageDoorOpenerPlatform } from './platform.js';
import { GarageState } from './garagestate.js';

export class GarageDoorOpenerAccessory {
  private service: Service;
  private garageState: GarageState;
  private lampService: Service | null = null;
  private ventService: Service | null = null;
  private lampOn = false;

  constructor(
    private readonly platform: GarageDoorOpenerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly state: GarageState | null = null,
  ) {
    this.platform.log.debug('constructing GarageDoorOpenerAccessory...');

    this.garageState = state ?? new GarageState(this.platform.api, this.platform.log);

    // Device info from firmware discovery
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.platform.discovery.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, this.platform.discovery.model)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.platform.discovery.swVersion)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.platform.discovery.ipAddress || 'unknown',
      );

    // Garage door service
    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
      || this.accessory.addService(this.platform.Service.GarageDoorOpener);

    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onSet(this.setTargetDoorState.bind(this))
      .onGet(this.getTargetDoorState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));

    // Lamp service (auto-enabled if discovered, override via config)
    if (this.platform.isLampEnabled()) {
      this.lampService = this.accessory.getService(this.platform.Service.Lightbulb)
        || this.accessory.addService(this.platform.Service.Lightbulb, 'Garage Lamp');

      this.lampService.updateCharacteristic(this.platform.Characteristic.Name, 'Garage Lamp');

      this.lampService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLampState.bind(this))
        .onGet(this.getLampState.bind(this));

      this.platform.log.debug('Lamp service initialized');
    }

    // Vent switch service (auto-enabled if discovered, override via config)
    if (this.platform.isVentEnabled()) {
      this.ventService = this.accessory.getService(this.platform.Service.Switch)
        || this.accessory.addService(this.platform.Service.Switch, 'Garage Vent');

      this.ventService.updateCharacteristic(this.platform.Characteristic.Name, 'Garage Vent');

      this.ventService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setVentState.bind(this))
        .onGet(this.getVentState.bind(this));

      this.platform.log.debug('Vent switch service initialized');
    }

    this.platform.log.debug('initial door states: ', this.garageState.description());
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

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

  // ─── Door ─────────────────────────────────────────────────────────────────

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

  // ─── Lamp ─────────────────────────────────────────────────────────────────

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
      return;
    }
    this.lampOn = value;
    this.lampService.getCharacteristic(this.platform.Characteristic.On).updateValue(value);
    this.platform.log.debug('Updated lamp state ->', value);
  }

  // ─── Vent ─────────────────────────────────────────────────────────────────

  setVentState(value: CharacteristicValue) {
    const turnOn = value as boolean;

    if (turnOn) {
      const currentState = this.garageState.getCurrentState();
      const isClosed = currentState === this.platform.Characteristic.CurrentDoorState.CLOSED;
      if (isClosed) {
        this.platform.log.debug('Sending vent command (door is closed)');
        this.platform.publishVentCommand();
      } else {
        this.platform.log.warn('Vent command ignored: door is not closed (state: ', currentState, ')');
        setTimeout(() => {
          this.ventService?.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        }, 500);
      }
    } else {
      if (this.platform.isCurrentlyVenting()) {
        this.platform.log.debug('Sending vent off command (was venting)');
        this.platform.publishVentOffCommand();
      } else {
        this.platform.log.warn('Vent off ignored: door is not venting');
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

  handleLogUpdate(value: string) {
    this.platform.log.info('log update: ', value);
  }
}
