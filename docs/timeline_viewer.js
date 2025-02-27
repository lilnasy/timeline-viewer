'use strict';

const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

// eslint-disable-next-line no-unused-vars
class Viewer {
  constructor() {
    this.params = new URL(location.href).searchParams;
    this.syncView = new SyncView();
    this.timelineParamValue = this.params.getAll('loadTimelineFromURL');
    this.timelineURL = this.timelineParamValue.at(0);

    this.timelineId = null;
    this.timelineProvider = 'url';

    this.totalSize = 50 * 1000 * 1000;
    this.loadingStarted = false;
    this.refreshPage = false;
    this.welcomeView = false;

    this.statusElem = document.getElementById('status');
    this.infoMessageElem = document.getElementById('info-message');
    this.networkOnlineStatusElem = document.getElementById('online-status');
    this.networkOfflineStatusElem = document.getElementById('offline-status');

    this.utils = new Utils();
    this.devTools = new DevTools({viewerInstance: this});

    this.attachEventListeners();


    this.displaySplitView = this.startSplitViewIfNeeded(this.timelineParamValue);
    if (this.displaySplitView) {
      this.splitViewContainer = document.getElementById('split-view-container');
    }

    this.welcomeView = !this.timelineURL;
    this.handleDragEvents();

    this.handleNetworkStatus();
    // only start up devtools if we have a param
    if (!this.displaySplitView && this.timelineURL) {
      void this.devTools.init();
    }

    if (!this.welcomeView) {
      this.makeDevToolsVisible(true);
    }
  }

  attachEventListeners() {
    this.attachSubmitUrlListener();
  }

  attachSubmitUrlListener() {
    const form = document.querySelector('form');
    form.addEventListener('submit', evt => {
      evt.preventDefault();
      const formdata = new FormData(evt.target);
      const url = formdata.get('url');
      if (!url) return;
      const parsedURL = new URL(location.href);
      parsedURL.searchParams.delete('loadTimelineFromURL');
      // this is weird because we don't want url encoding of the URL
      parsedURL.searchParams.append('loadTimelineFromURL', formdata.get('url'));
      if (formdata.get('url2')) {
        parsedURL.searchParams.append('loadTimelineFromURL', formdata.get('url2'));
      }
      location.href = parsedURL;
    });
  }


  handleDragEvents() {
    const dropboxEl = document.getElementById('dropbox');
    if (dropboxEl) {
      dropboxEl.addEventListener('dragover', this.dragover.bind(this), false);
    }
  }

  toggleUploadToDriveElem(display) {
    this.uploadToDriveElem.hidden = !display;
  }

  showInfoMessage(text) {
    this.infoMessageElem.textContent = text;
    this.infoMessageElem.hidden = false;

    setTimeout(() => {
      this.hideInfoMessage();
    }, 3000);
  }

  hideInfoMessage() {
    this.infoMessageElem.textContent = '';
    this.infoMessageElem.hidden = true;
  }

  async dragover(e) {
    e.stopPropagation();
    e.preventDefault();
    this.makeDevToolsVisible(true);

    await this.devTools.init();
    legacy.InspectorView.InspectorView.instance().showPanel('timeline').then(_ => {
      this.toggleUploadToDriveElem(this.canUploadToDrive);
    });
  }

  handleNetworkStatus() {
    if (navigator.onLine) {
      this.toggleNetworkStatusMessage();
    } else {
      this.toggleNetworkStatusMessage({status: 'offline'});
    }

    window.addEventListener('online', _ => {
      this.toggleNetworkStatusMessage();
    }, false);

    window.addEventListener('offline', _ => {
      this.toggleNetworkStatusMessage({status: 'offline'});
    }, false);
  }

  toggleNetworkStatusMessage(options = {status: 'online'}) {
    if (options.status === 'online') {
      this.networkOnlineStatusElem.hidden = false;
      this.networkOfflineStatusElem.hidden = true;
    } else {
      this.networkOnlineStatusElem.hidden = true;
      this.networkOfflineStatusElem.hidden = false;
    }
  }

  startSplitViewIfNeeded(urls) {
    if (urls.length > 1) {
      const frameset = document.createElement('frameset');
      frameset.setAttribute('id', 'split-view-container');
      frameset.setAttribute('rows', new Array(urls.length).fill(`${100/2}%`).join(','));

      urls.forEach((url, index) => {
        const frame = document.createElement('frame');
        frame.setAttribute('id', `split-view-${index}`);
        frame.setAttribute('src', `./?loadTimelineFromURL=${encodeURIComponent(url.trim())}`);
        frameset.appendChild(frame);
      });
      document.body.appendChild(frameset);
      document.documentElement.classList.add('fullbleed');
      document.querySelector('.welcome').remove();
      document.querySelector('.top-message-container').remove();
      return true;
    }
    return false;
  }

  makeDevToolsVisible(bool) {
    this.welcomeView = !bool;
    document.documentElement.classList.toggle('hide-devtools', this.welcomeView);
  }

  updateStatus(str) {
    this.statusElem.textContent = str;
  }
  // monkeypatched method for devtools
  async fetchPatched(...args) {
    const requestedURL = args.at(0).replace('/o/traces/', '/o/traces%2F');
    args[0] = requestedURL;
    const url = new URL(requestedURL, location.href);

    // pass through URLs that aren't our timelineURL param
    if (requestedURL !== this.timelineURL) {
      return this._orig_fetch.apply(window, args);
    }

    // This is comign from devtools starting its own fetch but we're gonna do an alleyoop through existing metadatastuff.
    if (this.timelineProvider === 'drive') {
      return this.driveAssetLoaded.then(payload => new Response(payload));
    }

    // adjustments for CORS
    url.hostname = url.hostname.replace('github.com', 'githubusercontent.com');
    url.hostname = url.hostname.replace('www.dropbox.com', 'dl.dropboxusercontent.com');

    return this.fetchTimelineAsset(url.href);
  }

  fetchTimelineAsset(url, addRequestHeaders = Function.prototype, method = 'GET', body) {
    this.loadingStarted = false;
    return this.utils.fetch(url.replace('/o/traces/', '/o/traces%2F'), {
      url, addRequestHeaders: addRequestHeaders.bind(this), method, body,
      onprogress: this.updateProgress.bind(this),
    }, true)
      .then(xhr => {
        this.makeDevToolsVisible(true);
        return new Response(xhr.responseText);
      })
      .catch(({error, xhr}) => {
        this.makeDevToolsVisible(false);
        this.updateStatus('Download of asset failed. ' + ((xhr.readyState == xhr.DONE) ? 'CORS headers likely not applied.' : ''));
        console.warn('Download of asset failed', error);
      });
  }

  async updateProgress(evt) {
    try {
      this.updateStatus(`Download progress: ${((evt.loaded / this.totalSize) * 100).toFixed(2)}%`);

      await legacy.InspectorView.InspectorView.instance().showPanel('timeline');
      const panel = await legacy.InspectorView.InspectorView.instance().panel('timeline');
      // start progress
      if (!this.loadingStarted) {
        this.loadingStarted = true;
        panel && panel.loadingStarted();
      }

      // update progress
      panel && panel.loadingProgress(evt.loaded / (evt.total || this.totalSize));

    } catch (e) {
      console.warn(e);
    }
  }


  changeUrl(id) {
    const url = `?loadTimelineFromURL=drive://${id}`;
    if (this.refreshPage) {
      window.location.href = `/${url}`;
    } else {
      const state = {'file_id': id};
      const title = 'Timeline Viewer';
      history.replaceState(state, title, url);
    }
  }
}
