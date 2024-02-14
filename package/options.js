/**
 * options.js
 *
 * Handles the saving and restoration of user options.
 * Options are stored and retrieved from Chrome's synchronized storage,
 * ensuring options are consistent across devices where the user is logged in.
 */


const ID = {
  rampConversion: 'rampConversion',
  rampConversionDesc: 'rampConversionDesc',
  ouConversion: 'ouConversion',
  ouConversionDesc: 'ouConversionDesc',
  saveButton: 'save',
  restoreDefaultsButton: 'restoreDefaults',
};

const rampConversionDescription = {
  none: 'Leave the ramps alone.',
  internal: 'Leave only warmup and/or cooldown ramps.',
  all: 'Convert all ramps to steady-state intervals.',
};

const ouConversionDescription = {
  strict: 'Over-under conversion requires power targets to match exactly.',
  loose: 'Over-under conversion may modify power targets slightly.',
  none: 'No over-under intervals will be created.',
};

const defaultOptions = {
  rampConversion: 'none',
  ouConversion: 'strict',
};


/**
 * Sanitizes the options object by validating and modifying its properties.
 * @param {Object} options - The options object to sanitize.
 * @return {Object} - The sanitized options object.
 */
function sanitizeOptions(options) {
  if (!Object.keys(rampConversionDescription)
      .includes(options?.rampConversion)) {
    console.log('Invalid rampConversion:', options?.rampConversion);
    options.rampConversion = defaultOptions.rampConversion;
  }
  if (!Object.keys(ouConversionDescription)
      .includes(options?.ouConversion)) {
    console.log('Invalid ouConversion:', options?.ouConversion);
    options.ouConversion = defaultOptions.ouConversion;
  }
  return options;
}

/**
 * Saves the options to Chrome storage.
 */
async function saveOptions() {
  /**
   * Retrieves options from the form.
   * @return {Object} - The options object.
   */
  function optionsFromForm() {
    return {
      rampConversion: document.getElementById(ID.rampConversion).value,
      ouConversion: document.getElementById(ID.ouConversion).value,
    };
  }

  const options = sanitizeOptions(optionsFromForm());
  try {
    await chrome.storage.sync.set({options});
    const status = document.createElement('div');
    status.textContent = 'Options saved.';
    console.log('Options saved:', options);
    document.body.appendChild(status);
    setTimeout(() => status.remove(), 750);
  } catch (error) {
    console.error('Error saving options:', error);
  }
}

/**
 * Restores the options from Chrome storage.
 */
async function restoreOptions() {
  /**
   * Retrieves the options from storage or returns default options.
   * @return {Promise<Object>} The options object.
   */
  async function getOptions() {
    const storedOptions = await chrome.storage.sync.get('options');
    const options = storedOptions.options || defaultOptions;
    return sanitizeOptions(options);
  }

  try {
    const options = await getOptions();
    document.getElementById(ID.rampConversion).value = options.rampConversion;
    document.getElementById(ID.ouConversion).value = options.ouConversion;
    document.getElementById(ID.rampConversion)
        .dispatchEvent(new Event('change'));
    document.getElementById(ID.ouConversion).
        dispatchEvent(new Event('change'));
  } catch (error) {
    console.error('Error restoring options:', error);
  }
}

/**
 * Restores the default options by removing the 'options' key from
 * chrome.storage.sync and then calling the restoreOptions function.
 * @return {Promise<void>} A promise that resolves when the default
 *                          options are restored.
 */
async function restoreDefaults() {
  try {
    await chrome.storage.sync.remove('options');
    restoreOptions();
  } catch (error) {
    console.error('Error restoring default options:', error);
  }
}

/**
 * Initializes the options page.
 */
function init() {
  /**
   * Updates the description element based on the selected value of the
   * rampConversion select element.
   */
  function rampConversionChanged() {
    const selectElement = document.getElementById(ID.rampConversion);
    const descElement = document.getElementById(ID.rampConversionDesc);
    descElement.textContent = rampConversionDescription[selectElement.value];
  }

  /**
   * Updates the description element based on the selected value of the
   * ouConversion select element.
   */
  function ouConversionChanged() {
    const selectElement = document.getElementById(ID.ouConversion);
    const descElement = document.getElementById(ID.ouConversionDesc);
    descElement.textContent = ouConversionDescription[selectElement.value];
  }

  document.addEventListener('DOMContentLoaded', restoreOptions);
  document.getElementById(ID.saveButton).addEventListener('click', saveOptions);
  document.getElementById(ID.restoreDefaultsButton)
      .addEventListener('click', restoreDefaults);
  document.getElementById(ID.rampConversion)
      .addEventListener('change', rampConversionChanged);
  document.getElementById(ID.ouConversion)
      .addEventListener('change', ouConversionChanged);
}

init();
