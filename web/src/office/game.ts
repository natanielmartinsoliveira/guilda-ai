import { t } from '../i18n';
import Phaser from 'phaser';
import { OfficeModel, ROLES, SPOTS, GuildAgent } from './spots';
import { WIDTH, HEIGHT, STATIONS, corridorRoute } from './layout';
export interface OfficeView {
  update(model: OfficeModel): void;
  destroy(): void;
}
const COLORS = { working: '#a9efbc', waiting: '#ffe09c', error: '#ffadad', idle: '#d6c7ee' };
export function createOffice(parent: HTMLElement, onSelect: (id: string) => void): OfficeView {
  let latest: OfficeModel | undefined;
  let scene: GuildScene | undefined;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = media.matches;
  class GuildScene extends Phaser.Scene {
    private actors = new Map<string, Phaser.GameObjects.Container>();
    private labels = new Map<string, Phaser.GameObjects.Text>();
    private screens = new Map<string, Phaser.GameObjects.Rectangle>();
    private previousCompleted?: Set<string>;
    private previousRoom?: string;
    private chest?: Phaser.GameObjects.Container;
    constructor() {
      super('guild');
    }
    preload() {
      this.load.spritesheet('people', '/app/assets/office/dungeon.png', {
        frameWidth: 16,
        frameHeight: 16,
      });
    }
    private text(x: number, y: number, value: string, size = 14, color = '#fff2d9') {
      return this.add
        .text(x, y, value, {
          fontFamily: 'monospace',
          fontSize: `${size}px`,
          color,
          resolution: 2,
          backgroundColor: '#30293c',
          padding: { x: 6, y: 4 },
        })
        .setOrigin(0.5)
        .setDepth(8);
    }
    private rect(x: number, y: number, w: number, h: number, color: number) {
      return this.add.rectangle(x, y, w, h, color).setOrigin(0);
    }
    private plant(x: number, y: number) {
      this.rect(x - 10, y, 20, 18, 0x9c6455);
      this.rect(x - 15, y - 22, 30, 22, 0x365f48);
      this.rect(x - 8, y - 34, 16, 34, 0x648e59);
      this.rect(x + 3, y - 25, 13, 12, 0x8ba86a);
    }
    private bookcase(x: number, y: number) {
      this.rect(x, y, 78, 38, 0x382c29);
      for (let i = 0; i < 9; i++)
        this.rect(x + 5 + i * 8, y + 5, 5, 23, [0x8a6999, 0x62856c, 0xc09d6a][i % 3]);
      this.rect(x, y + 30, 78, 6, 0xa07b54);
    }
    private monitor(x: number, y: number, role: string) {
      this.rect(x - 25, y - 25, 50, 31, 0x252c3a);
      this.rect(x - 20, y - 20, 40, 20, 0x385d58);
      for (let i = 0; i < 3; i++) this.rect(x - 16, y - 16 + i * 5, 22 - i * 4, 2, 0x9bcb9a);
      this.rect(x - 3, y + 6, 6, 6, 0x333340);
      this.screens.set(role, this.add.rectangle(x + 15, y - 14, 4, 4, 0xaceebc));
    }
    create() {
      this.cameras.main.setBounds(0, 0, WIDTH, HEIGHT);
      this.rect(0, 0, WIDTH, HEIGHT, 0x383542);
      for (let y = 32; y < HEIGHT - 30; y += 24)
        for (let x = 32; x < WIDTH - 30; x += 64) {
          const offset = ((y / 24) % 2) * 32;
          this.rect(Math.max(32, x - offset), y, 62, 22, (x + y) % 3 ? 0x866045 : 0x916b4d);
          this.rect(Math.max(34, x - offset + 5), y + 17, 30, 1, 0xa67c56);
        }
      for (let x = 0; x < WIDTH; x += 48) {
        this.rect(x, 0, 46, 28, 0x5d5864);
        this.rect(x, HEIGHT - 28, 46, 26, 0x504b57);
      }
      for (let y = 30; y < HEIGHT - 30; y += 32) {
        this.rect(0, y, 28, 30, 0x5d5864);
        this.rect(WIDTH - 28, y, 28, 30, 0x5d5864);
      }
      for (const x of [75, 885]) {
        this.rect(x - 20, 39, 40, 53, 0x352d43);
        this.rect(x - 15, 44, 30, 42, 0x768d91);
        this.rect(x - 2, 44, 4, 42, 0xc3a274);
        this.rect(x - 15, 62, 30, 4, 0xc3a274);
      }
      for (const [x, y] of [
        [60, 150],
        [900, 150],
        [60, 390],
        [900, 390],
      ]) {
        this.add.circle(x, y, 40, 0xffc676, 0.08);
        this.rect(x - 6, y - 8, 12, 20, 0xdfb069);
        this.rect(x - 3, y - 12, 6, 12, 0xffe6a3);
      }
      for (const [x, y] of [
        [55, 110],
        [910, 110],
        [55, 530],
        [905, 530],
      ])
        this.plant(x, y);
      this.bookcase(130, 39);
      this.bookcase(650, 39);
      this.rect(285, 43, 140, 46, 0x503c30);
      this.rect(292, 49, 126, 31, 0xbe9c70);
      for (let i = 0; i < 4; i++) this.rect(302 + i * 28, 54, 18, 22, 0xe8d5a5);
      this.text(355, 101, t('guild.missionBoard'), 13);
      this.rect(493, 45, 130, 39, 0x645077);
      this.text(558, 64, t('status.waiting'), 12, '#ffe0a6');
      // Collaboration table is between the two aisles; neither crosses it.
      this.rect(336, 281, 288, 52, 0x674d77);
      this.rect(345, 285, 270, 44, 0x856493);
      this.rect(382, 291, 194, 35, 0x4e342b);
      this.rect(387, 287, 184, 33, 0xb48a5b);
      for (const x of [416, 473, 530]) {
        this.rect(x, 295, 25, 18, 0xe4d3a7);
        this.rect(x + 4, 300, 16, 2, 0x8a9a83);
      }
      this.text(480, 304, t('guild.planningTable'), 12);
      ROLES.forEach((role) => {
        const { x, y, frame } = STATIONS[role];
        this.rect(x - 108, y - 52, 216, 108, 0x594750);
        this.rect(x - 104, y - 48, 208, 100, 0x756078);
        this.rect(x - 73, y - 20, 146, 43, 0x493329);
        this.rect(x - 70, y - 23, 140, 37, 0xb08a60);
        this.rect(x - 63, y + 16, 10, 13, 0x493329);
        this.rect(x + 53, y + 16, 10, 13, 0x493329);
        if (role === 'coder' || role === 'guard') {
          this.monitor(x - 30, y - 12, role);
          this.monitor(x + 30, y - 12, role + '2');
        }
        if (role === 'architect') {
          this.plant(x - 57, y - 12);
          this.rect(x - 15, y - 28, 56, 35, 0xe3d1a7);
          this.rect(x - 8, y - 22, 35, 2, 0x648274);
          this.rect(x + 7, y - 22, 2, 22, 0x648274);
        }
        if (role === 'tester') {
          this.monitor(x - 33, y - 12, role);
          this.rect(x + 12, y - 30, 34, 33, 0xe5d8b5);
          for (let i = 0; i < 3; i++) {
            this.rect(x + 17, y - 24 + i * 8, 5, 5, 0x63906c);
            this.rect(x + 26, y - 23 + i * 8, 15, 2, 0x867962);
          }
        }
        if (role === 'fixer') {
          this.rect(x - 45, y - 33, 80, 27, 0x4a4c54);
          for (let i = 0; i < 4; i++) {
            this.rect(x - 33 + i * 18, y - 26, 4, 21, 0xb9bdc3);
            this.rect(x - 37 + i * 18, y - 27, 12, 5, 0xb9bdc3);
          }
          this.rect(x + 48, y - 15, 16, 22, 0x627a6b);
        }
        if (role === 'reviewer') {
          for (let i = 0; i < 3; i++)
            this.rect(x - 46 + i * 24, y - 29, 20, 30, [0x72598b, 0xb5a780, 0xe6d5ae][i]);
          this.add.circle(x + 42, y - 21, 10, 0xb6c7c4);
          this.add.circle(x + 42, y - 21, 6, 0x627a6b);
          this.rect(x + 47, y - 14, 5, 14, 0x403442);
        }
        if (role === 'guard') {
          this.add.polygon(
            x + 88,
            y - 8,
            [0, -14, 12, -9, 10, 7, 0, 16, -10, 7, -12, -9],
            0xa3c39e,
          );
          this.add.polygon(x + 88, y - 8, [0, -9, 7, -6, 6, 5, 0, 10, -6, 5, -7, -6], 0x416852);
        }
        const actor = this.add
          .container(x, y + 61, [
            this.add.ellipse(0, 12, 25, 8, 0x362d38, 0.5),
            this.add.image(0, 0, 'people', frame).setScale(2),
          ])
          .setDepth(7);
        actor
          .setSize(40, 42)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => onSelect('@' + role));
        this.actors.set(role, actor);
        const warning = this.add
          .text(11, -23, '!', {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: '#ffe0a6',
            backgroundColor: '#30293c',
          })
          .setVisible(false);
        actor.add(warning);
        this.text(x, y - 70, SPOTS[role].label, 15);
        this.labels.set(role, this.text(x, y + 97, t('app.loading'), 12));
        this.add
          .zone(x, y, 210, 105)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => onSelect('@' + role));
      });
      this.rect(635, 573, 210, 25, 0x4b6558);
      this.rect(635, 563, 210, 14, 0x78967e);
      this.rect(854, 574, 40, 28, 0x53382d);
      this.rect(854, 570, 40, 8, 0xb28758);
      this.rect(866, 554, 12, 14, 0xe5cf9d);
      this.text(755, 613, t('guild.pantryLong'), 12);
      this.rect(108, 573, 153, 26, 0x513d30);
      for (let i = 0; i < 4; i++) this.rect(117 + i * 34, 578, 25, 14, 0xd9c49b);
      this.text(184, 612, t('guild.taskQueue'), 12);
      this.chest = this.add.container(490, 581, [
        this.add.rectangle(0, 0, 68, 34, 0x7c5338),
        this.add.rectangle(0, -14, 72, 8, 0xd6ad62),
        this.add.rectangle(0, 0, 9, 14, 0xe1c475),
      ]);
      this.text(490, 613, t('guild.deliveryChest'), 12);
      this.chest
        .setSize(85, 46)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => onSelect('@delivery'));
      this.add
        .zone(355, 65, 140, 65)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => onSelect('@mural'));
      this.add
        .zone(558, 64, 135, 46)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => onSelect('@waiting'));
      this.add
        .zone(184, 581, 155, 40)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => onSelect('@queue'));
      this.fit();
      this.scale.on('resize', () => this.fit());
      scene = this;
      if (latest) this.apply(latest);
    }
    private fit() {
      this.cameras.main
        .setZoom(Math.min(this.scale.width / WIDTH, this.scale.height / HEIGHT))
        .centerOn(WIDTH / 2, HEIGHT / 2);
    }
    private move(role: string, agent: GuildAgent, index: number) {
      const actor = this.actors.get(role)!;
      const s = STATIONS[agent.role];
      const dest =
        agent.tone === 'idle' ? { x: 650 + index * 35, y: 539 } : { x: s.x, y: s.y + 61 };
      const previous = actor.getData('destination') as string | undefined;
      const key = `${dest.x},${dest.y}`;
      if (previous === key) return;
      actor.setData('destination', key);
      this.tweens.killTweensOf(actor);
      // First snapshot places characters directly; subsequent state changes follow aisles.
      if (reduced || !previous) {
        actor.setPosition(dest.x, dest.y);
        return;
      }
      const points = corridorRoute({ x: actor.x, y: actor.y }, dest);
      const next = () => {
        const p = points.shift();
        if (!p) return;
        this.tweens.add({
          targets: actor,
          x: p.x,
          y: p.y,
          duration: Math.max(120, Phaser.Math.Distance.Between(actor.x, actor.y, p.x, p.y) * 4),
          onComplete: next,
        });
      };
      next();
    }
    apply(model: OfficeModel) {
      const guild = model.guild;
      if (!guild || model.loaded === false) return;
      if (model.roomKey !== this.previousRoom) {
        this.previousCompleted = undefined;
        this.previousRoom = model.roomKey;
        for (const actor of this.actors.values()) {
          this.tweens.killTweensOf(actor);
          actor.setData('destination', undefined);
        }
      }
      guild.agents.forEach((agent, index) => {
        const label = this.labels.get(agent.role)!;
        label
          .setText(
            `${agent.tone === 'working' ? '◆' : agent.tone === 'error' ? '!' : agent.tone === 'waiting' ? '◷' : '○'} ${agent.status}${agent.tasks.length > 1 ? ' · ' + agent.tasks.length : ''}`,
          )
          .setColor(COLORS[agent.tone]);
        this.move(agent.role, agent, index);
        for (const key of [agent.role, agent.role + '2']) {
          const screen = this.screens.get(key);
          if (!screen) continue;
          this.tweens.killTweensOf(screen);
          screen.setAlpha(agent.tone === 'working' ? 1 : 0.35);
          if (agent.tone === 'working' && !reduced)
            this.tweens.add({
              targets: screen,
              alpha: 0.35,
              duration: 850,
              yoyo: true,
              repeat: -1,
            });
        }
        const actor = this.actors.get(agent.role)!;
        (actor.list[2] as Phaser.GameObjects.Text)
          .setVisible(agent.tone === 'error' || agent.tone === 'waiting')
          .setColor(COLORS[agent.tone]);
        const sprite = actor.list[1] as Phaser.GameObjects.Image;
        this.tweens.killTweensOf(sprite);
        sprite.y = 0;
        if (agent.tone === 'working' && !reduced)
          this.tweens.add({ targets: sprite, y: -2, duration: 600, yoyo: true, repeat: -1 });
      });
      const completed = new Set(guild.completed);
      if (
        this.previousCompleted &&
        guild.completed.some((id) => !this.previousCompleted!.has(id)) &&
        !reduced
      )
        this.tweens.add({
          targets: this.chest,
          scaleX: 1.12,
          scaleY: 1.12,
          duration: 250,
          yoyo: true,
          repeat: 2,
        });
      this.previousCompleted = completed;
    }
    stopMotion() {
      this.tweens.killAll();
      for (const actor of this.actors.values()) actor.setData('destination', undefined);
      if (latest) this.apply(latest);
    }
  }
  const changed = () => {
    reduced = media.matches;
    scene?.stopMotion();
  };
  media.addEventListener('change', changed);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    backgroundColor: '#30293c',
    banner: false,
    audio: { noAudio: true },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: parent.clientWidth || WIDTH,
      height: parent.clientHeight || HEIGHT,
    },
    scene: GuildScene,
  });
  return {
    update(model) {
      latest = model;
      scene?.apply(model);
    },
    destroy() {
      media.removeEventListener('change', changed);
      scene = undefined;
      game.destroy(true);
    },
  };
}
