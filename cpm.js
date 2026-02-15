const cpm = {
  /**
   * Installs (downloads) a file from a given URL as a Blob.
   * This forces the browser to download instead of opening the file.
   * @param {string} url 
   */
  install: async function(url) {
    if (!url) {
      console.error("CPM Error: No URL provided!");
      return;
    }

    console.log(`[CPM] Fetching package from: ${url}...`);

    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const blob = await response.blob();
      const name = url.split('/').pop() || 'download.txt';
      const blobUrl = window.URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = blobUrl;
      link.setAttribute('download', name);
      link.style.display = 'none';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);

      console.log(`[CPM] Successfully installed: ${name}`);
    } catch (error) {
      console.error(`[CPM] Installation failed: ${error.message}`);
    }
  }
};
window.cpm = cpm;