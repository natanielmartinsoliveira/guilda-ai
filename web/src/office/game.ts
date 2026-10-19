import Phaser from 'phaser';
import { t } from '../i18n';
import type { OfficeModel } from './spots';
import { RoomView, type OfficeSelection } from './room';
import {
  campusLayout,
  companyCaption,
  campusCameraFocus,
  roomCameraFocus,
  COMPANY_COLORS,
  type RoomModel,
  type CampusLayout,
} from './campus';
import { cameraFocus, type CameraMode, type Focus } from './camera';
import type { Point } from './layout';
import { themeFor } from './themes';
export type { OfficeSelection } from './room';
export interface OfficeView {
  update(model: OfficeModel): void;
  setCameraMode(mode: CameraMode): void;
  zoomBy(factor: number): void;
  focus(taskId: string, tenantId: string): void;
  focusRoom(tenantId: string): void;
  onCameraModeChange(cb: (mode: CameraMode) => void): void;
  destroy(): void;
}
export function createOffice(
  parent: HTMLElement,
  onSelect: (selection: OfficeSelection) => void,
): OfficeView {
  let latest: OfficeModel | undefined, scene: GuildScene | undefined;
  let mode: CameraMode = 'follow',
    modeChanged: ((mode: CameraMode) => void) | undefined;
  let pendingFocus: { taskId: string; tenantId: string } | undefined;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = media.matches;
  class GuildScene extends Phaser.Scene {
    private rooms = new Map<string, RoomView>();
    private definitions: RoomModel[] = [];
    private layout: CampusLayout = { width: 960, height: 640, rooms: [] };
    private geometry = '';
    private modeKey?: string;
    private plates = new Map<string, Phaser.GameObjects.Text>();
    private yard?: Phaser.GameObjects.Graphics;
    private target?: Focus;
    private cameraAt = 0;
    private batching = false;
    private starts = new Map<number, Point>();
    private dragged = false;
    private pinchDistance = 0;
    constructor() {
      super('guild');
    }
    preload() {
      this.load.spritesheet('town', '/app/assets/office/town.png', {
        frameWidth: 16,
        frameHeight: 16,
      });
      this.load.spritesheet('people', '/app/assets/office/dungeon.png', {
        frameWidth: 16,
        frameHeight: 16,
      });
    }
    create() {
      const camera = this.cameras.main;
      const clampX = camera.clampX.bind(camera),
        clampY = camera.clampY.bind(camera);
      camera.clampX = (x) =>
        camera.displayWidth >= this.layout.width
          ? (this.layout.width - camera.width) / 2
          : clampX(x);
      camera.clampY = (y) =>
        camera.displayHeight >= this.layout.height
          ? (this.layout.height - camera.height) / 2
          : clampY(y);
      this.controls();
      this.scale.on('resize', () => {
        const min = Math.min(
          this.scale.width / this.layout.width,
          this.scale.height / this.layout.height,
        );
        camera.setZoom(Phaser.Math.Clamp(camera.zoom, min, Math.max(2.5, min)));
        this.target = undefined;
        this.updateCamera(false);
      });
      scene = this;
      if (latest) this.apply(latest);
      if (pendingFocus) this.focusMember(pendingFocus.taskId, pendingFocus.tenantId);
    }
    private click(pointer: Phaser.Input.Pointer, action: () => void) {
      const start = this.starts.get(pointer.id);
      if (
        !this.dragged &&
        start &&
        Phaser.Math.Distance.Between(start.x, start.y, pointer.x, pointer.y) <= 6
      )
        action();
    }
    private drawYard() {
      this.yard ??= this.add.graphics().setDepth(-10);
      this.yard.clear().fillStyle(0x252531).fillRect(0, 0, this.layout.width, this.layout.height);
      for (const [i, room] of this.layout.rooms.entries()) {
        const next = this.layout.rooms[i + 1];
        if (next && next.offset.y === room.offset.y) {
          const x = room.offset.x + room.layout.width,
            y = room.offset.y + room.layout.height / 2;
          this.yard.fillStyle(0x514c5e).fillRect(x, y - 16, 96, 32);
          for (let tile = 0; tile < 4; tile++)
            this.yard.fillStyle(0x706777).fillRect(x + tile * 24 + 2, y - 12, 20, 24);
        }
      }
    }
    apply(model: OfficeModel) {
      if (model.loaded === false) return;
      const campus = !!model.rooms;
      const definitions = model.rooms ?? [
        {
          tenantId: model.tenantId ?? model.roomKey ?? '',
          name: '',
          model,
          seats: model.seats ?? 1,
          theme: model.theme,
        },
      ];
      const reset = this.modeKey !== model.roomKey;
      const layout = campusLayout(definitions);
      const geometry = JSON.stringify(
        layout.rooms.map((r, i) => [
          r.tenantId,
          r.offset,
          r.layout.seats,
          r.layout.width,
          r.layout.height,
          definitions[i].theme,
        ]),
      );
      const changed = reset || geometry !== this.geometry;
      this.batching = true;
      if (reset) {
        for (const room of this.rooms.values()) room.destroy();
        this.rooms.clear();
        for (const plate of this.plates.values()) plate.destroy();
        this.plates.clear();
        this.target = undefined;
      }
      this.modeKey = model.roomKey;
      this.geometry = geometry;
      this.definitions = definitions;
      this.layout = layout;
      if (changed) {
        this.starts.clear();
        this.dragged = true;
        const camera = this.cameras.main;
        camera.setBounds(0, 0, layout.width, layout.height);
        if (mode === 'manual') {
          const min = Math.min(this.scale.width / layout.width, this.scale.height / layout.height);
          camera.setZoom(Phaser.Math.Clamp(camera.zoom, min, Math.max(2.5, min)));
        }
        this.drawYard();
      }
      for (const [id, room] of this.rooms)
        if (!definitions.some((r) => r.tenantId === id)) {
          room.destroy();
          this.rooms.delete(id);
          this.plates.get(id)?.destroy();
          this.plates.delete(id);
        }
      definitions.forEach((definition, index) => {
        const placement = layout.rooms[index],
          color = COMPANY_COLORS[index % COMPANY_COLORS.length];
        let room = this.rooms.get(definition.tenantId);
        if (!room) {
          room = new RoomView(
            this,
            definition,
            placement.offset,
            campus,
            color,
            () => reduced,
            (pointer, selection) => this.click(pointer, () => onSelect(selection)),
            () => {
              if (!this.batching) this.updateCamera();
            },
          );
          this.rooms.set(definition.tenantId, room);
        }
        room.setPlacement(placement.offset, color);
        room.apply(definition);
        if (campus) {
          let plate = this.plates.get(definition.tenantId);
          if (!plate) {
            plate = this.add
              .text(0, 0, '', {
                fontFamily: 'monospace',
                fontSize: '18px',
                backgroundColor: '#30293c',
                padding: { x: 18, y: 12 },
                resolution: 2,
                wordWrap: { width: Math.min(560, room.layout.width - 96), useAdvancedWrap: true },
              })
              .setOrigin(0.5)
              .setDepth(10)
              .setName(definition.tenantId + ':plate')
              .setInteractive({ useHandCursor: true });
            plate.on('pointerup', (pointer: Phaser.Input.Pointer) =>
              this.click(pointer, () => this.focusRoom(definition.tenantId)),
            );
            this.plates.set(definition.tenantId, plate);
          }
          const palette = themeFor(definition.theme).palette;
          plate
            .setBackgroundColor(palette.plate)
            .setPosition(placement.offset.x + room.layout.width / 2, placement.offset.y - 48)
            .setColor(palette.plateText ?? color)
            .setStroke(color, palette.plateText ? 2 : 0)
            .setText(
              companyCaption(
                definition.name,
                definition.running ?? definition.model.guild?.active ?? 0,
              ),
            );
          plate.setData(
            'label',
            t('guild.companySign', { name: definition.name, n: definition.running ?? 0 }),
          );
        }
      });
      this.batching = false;
      if (changed) this.target = undefined;
      this.updateCamera(!changed);
    }
    private viewSize() {
      return { width: this.scale.width, height: this.scale.height };
    }
    setMode(next: CameraMode) {
      mode = next;
      modeChanged?.(mode);
      this.target = undefined;
      this.cameras.main.panEffect.reset();
      this.cameras.main.zoomEffect.reset();
      if (mode !== 'manual') this.updateCamera();
    }
    private applyFocus(focus: Focus, animate = true) {
      const camera = this.cameras.main;
      if (animate && !reduced) {
        camera.pan(focus.x, focus.y, 600, 'Sine.easeInOut', true);
        camera.zoomTo(focus.zoom, 600, 'Sine.easeInOut', true);
      } else {
        camera.panEffect.reset();
        camera.zoomEffect.reset();
        camera.setZoom(focus.zoom).centerOn(focus.x, focus.y);
      }
      this.target = focus;
    }
    private updateCamera(animate = true) {
      if (mode === 'manual' || this.batching) return;
      const actors = [...this.rooms.values()].flatMap((r) => r.targets());
      const focus = campusCameraFocus(
        this.definitions,
        this.layout,
        actors,
        this.viewSize(),
        mode === 'overview',
      );
      if (
        this.target &&
        Math.hypot(focus.x - this.target.x, focus.y - this.target.y) < 24 &&
        Math.abs(focus.zoom / this.target.zoom - 1) < 0.05
      )
        return;
      this.applyFocus(focus, animate);
    }
    update(time: number) {
      for (const room of this.rooms.values()) room.tick();
      if (
        !reduced &&
        mode === 'follow' &&
        time - this.cameraAt >= 400 &&
        [...this.rooms.values()].some((r) => r.targets().some((a) => a.moving))
      ) {
        this.cameraAt = time;
        this.updateCamera();
      }
    }
    zoom(factor: number, point?: Point) {
      this.setMode('manual');
      const camera = this.cameras.main;
      const offset = point
        ? { x: point.x - camera.x - camera.width / 2, y: point.y - camera.y - camera.height / 2 }
        : undefined;
      const anchor = offset
        ? {
            x: camera.scrollX + camera.width / 2 + offset.x / camera.zoom,
            y: camera.scrollY + camera.height / 2 + offset.y / camera.zoom,
          }
        : undefined;
      const min = Math.min(
        this.scale.width / this.layout.width,
        this.scale.height / this.layout.height,
      );
      camera.setZoom(Phaser.Math.Clamp(camera.zoom * factor, min, Math.max(2.5, min)));
      if (offset && anchor) {
        camera.scrollX = anchor.x - camera.width / 2 - offset.x / camera.zoom;
        camera.scrollY = anchor.y - camera.height / 2 - offset.y / camera.zoom;
      }
      for (const room of this.rooms.values()) room.tick();
    }
    focusMember(taskId: string, tenantId: string) {
      this.setMode('manual');
      const room = this.rooms.get(tenantId);
      const point = room?.focusPoint(taskId);
      if (room && point) {
        this.applyFocus(
          cameraFocus(
            [{ x: room.offset.x + point.x, y: room.offset.y + point.y }],
            this.viewSize(),
            this.layout,
            { minZoom: 1.5 },
          ),
          !reduced,
        );
        return;
      }
    }
    focusRoom(tenantId: string) {
      const placement = this.layout.rooms.find((r) => r.tenantId === tenantId);
      if (!placement) return;
      this.setMode('manual');
      this.applyFocus(roomCameraFocus(placement, this.viewSize(), this.layout), !reduced);
    }
    private pan(dx: number, dy: number) {
      this.setMode('manual');
      const c = this.cameras.main;
      c.scrollX -= dx / c.zoom;
      c.scrollY -= dy / c.zoom;
    }
    private controls() {
      this.input.addPointer(1);
      this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
        if (!this.input.manager.pointers.some((other) => other !== p && other.isDown))
          this.dragged = false;
        this.starts.set(p.id, { x: p.x, y: p.y });
        this.pinchDistance = 0;
      });
      this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
        if (!p.isDown) return;
        const touches = this.input.manager.pointers.filter((t) => t.isDown && t.wasTouch);
        if (touches.length >= 2) {
          const distance = Phaser.Math.Distance.Between(
            touches[0].x,
            touches[0].y,
            touches[1].x,
            touches[1].y,
          );
          if (this.pinchDistance)
            this.zoom(distance / this.pinchDistance, {
              x: (touches[0].x + touches[1].x) / 2,
              y: (touches[0].y + touches[1].y) / 2,
            });
          this.pinchDistance = distance;
          this.dragged = true;
          return;
        }
        const start = this.starts.get(p.id);
        if (start && Phaser.Math.Distance.Between(start.x, start.y, p.x, p.y) > 6)
          this.dragged = true;
        if (this.dragged) this.pan(p.x - p.prevPosition.x, p.y - p.prevPosition.y);
      });
      this.input.on(
        'wheel',
        (p: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
          this.zoom(Math.exp(-dy * 0.001), p);
        },
      );
    }
    keyboard(event: KeyboardEvent) {
      const pan: Record<string, Point> = {
        ArrowLeft: { x: 48, y: 0 },
        ArrowRight: { x: -48, y: 0 },
        ArrowUp: { x: 0, y: 48 },
        ArrowDown: { x: 0, y: -48 },
      };
      if (pan[event.key]) {
        event.preventDefault();
        this.pan(pan[event.key].x, pan[event.key].y);
      } else if (['+', '=', '-'].includes(event.key)) {
        event.preventDefault();
        this.zoom(event.key === '-' ? 1 / 1.2 : 1.2);
      }
    }

    stopMotion() {
      const focus = this.target;
      this.cameras.main.panEffect.reset();
      this.cameras.main.zoomEffect.reset();
      this.batching = true;
      for (const room of this.rooms.values()) room.stopMotion();
      this.batching = false;
      this.target = undefined;
      this.updateCamera(false);
      if (mode === 'manual' && focus) this.applyFocus(focus, false);
    }
    dispose() {
      for (const room of this.rooms.values()) room.destroy();
      this.rooms.clear();
    }
  }
  const changed = () => {
    reduced = media.matches;
    scene?.stopMotion();
  };
  const keyboard = (event: KeyboardEvent) => scene?.keyboard(event);
  const region = parent.parentElement;
  media.addEventListener('change', changed);
  region?.addEventListener('keydown', keyboard);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    backgroundColor: '#30293c',
    banner: false,
    audio: { noAudio: true },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: parent.clientWidth || 960,
      height: parent.clientHeight || 640,
    },
    scene: GuildScene,
  });
  return {
    update(model) {
      if (latest?.roomKey !== model.roomKey) pendingFocus = undefined;
      latest = model;
      scene?.apply(model);
    },
    setCameraMode(next) {
      if (scene) scene.setMode(next);
      else {
        mode = next;
        modeChanged?.(mode);
      }
    },
    zoomBy(factor) {
      scene?.zoom(factor);
    },
    focus(taskId, tenantId) {
      if (scene) scene.focusMember(taskId, tenantId);
      else pendingFocus = { taskId, tenantId };
    },
    focusRoom(tenantId) {
      scene?.focusRoom(tenantId);
    },
    onCameraModeChange(cb) {
      modeChanged = cb;
      cb(mode);
    },
    destroy() {
      media.removeEventListener('change', changed);
      region?.removeEventListener('keydown', keyboard);
      modeChanged = undefined;
      scene?.dispose();
      scene = undefined;
      game.destroy(true);
    },
  };
}
