/* global Zotero, Services */
var ClaudeReaderAssistant;

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	Services.scriptloader.loadSubScript(rootURI + 'content/assistant.js');
	ClaudeReaderAssistant.init({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
	ClaudeReaderAssistant?.attachAll();
}

function onMainWindowUnload({ window }) {
	ClaudeReaderAssistant?.detachAll(window);
}

function shutdown() {
	ClaudeReaderAssistant?.shutdown();
	ClaudeReaderAssistant = undefined;
}

function uninstall() {}
