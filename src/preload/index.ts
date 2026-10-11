import { contextBridge, ipcRenderer } from 'electron';
import { channels } from '../shared/contracts';
import type { PetAPI, DesktopState, ChatState } from '../shared/contracts';

const api: PetAPI = {
  openDataAdmin: section => ipcRenderer.invoke(channels.openDataAdmin, section),
  onAdminNavigate: callback => { const handler = (_event: unknown, section: string) => callback(section); ipcRenderer.on(channels.adminNavigate, handler); return () => ipcRenderer.removeListener(channels.adminNavigate, handler); },
  dataOverview: () => ipcRenderer.invoke(channels.dataOverview),
  dataQuery: value => ipcRenderer.invoke(channels.dataQuery, value),
  dataMutate: value => ipcRenderer.invoke(channels.dataMutate, value),
  dataExport: value => ipcRenderer.invoke(channels.dataExport, value),
  getChat: () => ipcRenderer.invoke(channels.getChat),
  retractMessage: value => ipcRenderer.invoke(channels.retractMessage, value),
  editMessage: value => ipcRenderer.invoke(channels.editMessage, value),
  regenerateReply: value => ipcRenderer.invoke(channels.regenerateReply, value),
  configureModel: value => ipcRenderer.invoke(channels.configureModel, value),
  pickChatImages: value => ipcRenderer.invoke(channels.pickChatImages, value),
  discardChatImages: value => ipcRenderer.invoke(channels.discardChatImages, value),
  sendChat: value => ipcRenderer.invoke(channels.sendChat, value),
  cancelChat: value => ipcRenderer.invoke(channels.cancelChat, value),
  newConversation: value => ipcRenderer.invoke(channels.newConversation, value),
  selectConversation: value => ipcRenderer.invoke(channels.selectConversation, value),
  clearChatHistory: value => ipcRenderer.invoke(channels.clearChatHistory, value),
  chatHistory: value => ipcRenderer.invoke(channels.chatHistory, value),
  summarizeChat: value => ipcRenderer.invoke(channels.summarizeChat, value),
  extractLongMemory: value => ipcRenderer.invoke(channels.extractLongMemory, value),
  discardSummary: value => ipcRenderer.invoke(channels.discardSummary, value),
  addMemory: value => ipcRenderer.invoke(channels.addMemory, value),
  deleteMemory: value => ipcRenderer.invoke(channels.deleteMemory, value),
  openChat: () => ipcRenderer.invoke(channels.openChat),
  onChat: callback => {
    const handler = (_event: unknown, value: ChatState) => callback(value);
    ipcRenderer.on(channels.chatChanged, handler); return () => ipcRenderer.removeListener(channels.chatChanged, handler);
  },
  getState: () => ipcRenderer.invoke(channels.getState),
  setPreferences: patch => ipcRenderer.invoke(channels.setPreferences, patch),
  setExpression: expression => ipcRenderer.invoke(channels.setExpression, expression),
  interact: event => ipcRenderer.invoke(channels.interact, event),
  playAction: action => ipcRenderer.invoke(channels.playAction, action),
  stopAction: () => ipcRenderer.invoke(channels.stopAction),
  dismissBubble: () => ipcRenderer.invoke(channels.dismissBubble),
  stageReady: epoch => ipcRenderer.invoke(channels.stageReady, epoch),
  animationFinished: value => ipcRenderer.invoke(channels.animationFinished, value),
  prepareCharacter: id => ipcRenderer.invoke(channels.prepareCharacter, id),
  commitCharacter: token => ipcRenderer.invoke(channels.commitCharacter, token),
  setHover: inside => ipcRenderer.invoke(channels.setHover, inside),
  setBubbleHover: inside => ipcRenderer.invoke(channels.setBubbleHover, inside),
  dragStart: point => ipcRenderer.invoke(channels.dragStart, point),
  dragMove: point => ipcRenderer.invoke(channels.dragMove, point),
  dragEnd: () => ipcRenderer.invoke(channels.dragEnd),
  dragCancel: () => ipcRenderer.invoke(channels.dragCancel),
  openSettings: () => ipcRenderer.invoke(channels.openSettings),
  openMenu: () => ipcRenderer.invoke(channels.openMenu),
  hide: () => ipcRenderer.invoke(channels.hide),
  resetPosition: () => ipcRenderer.invoke(channels.resetPosition),
  quit: () => ipcRenderer.invoke(channels.quit),
  onState: callback => {
    const handler = (_event: unknown, state: DesktopState) => callback(state);
    ipcRenderer.on(channels.changed, handler);
    return () => ipcRenderer.removeListener(channels.changed, handler);
  }
};
contextBridge.exposeInMainWorld('petAPI', Object.freeze(api));
