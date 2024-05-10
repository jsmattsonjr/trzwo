/**
 * This is the content script for a Chrome extension.
 *
 * The script adds a 'ZWO' button next to the 'Open in App' button on a workout
 * page on the TrainerRoad website. The 'ZWO' button triggers the download of
 * a .zwo file corresponding to the current TrainerRoad workout.
 */


/**
 * Enum representing the types of intervals in a ZWO file.
 * @enum {string}
 * @readonly
 */
const IntervalType = Object.freeze({
  STEADY_STATE: 'SteadyState', // Constant power target for the duration
  RAMP: 'Ramp', // Linearly increasing/decreasing power target over the duration
  OVER_UNDER: 'IntervalsT', // Alternating constant power targets
});


/**
 * Determines the Zwift intervals from the provided workout data based on the
 * given options. The workout data is expected to be an array of objects with
 * 'Seconds' [sic] and 'FtpPercent' attributes, indicating the power target
 * beginning at the given time.
 * @param {Array} data - The workout data to analyze.
 * @param {Object} options - The options for analyzing the intervals.
 * @return {Array} - The array of Zwift intervals.
 */
function getZwiftIntervals(data, options) {
  /**
   * Checks if the provided workout data follows the expected
   * conventions.
   * @param {Array} data - The workout data to validate.
   * @return {boolean} - True if the workout data is valid, false otherwise.
   */
  function validWorkoutData(data) {
    if (!Array.isArray(data)) {
      console.log('WorkoutData is not an array');
      return false;
    }
    if (data.length < 2) {
      console.log('WorkoutData has less than 2 data points');
      return false;
    }
    if (data.some((dataPoint, index) =>
      typeof dataPoint?.Seconds !== 'number' || dataPoint.Seconds < 0 ||
      typeof dataPoint?.FtpPercent !== 'number' || dataPoint.FtpPercent < 0 ||
      dataPoint.Seconds % 1000 !== 0 ||
      (index > 0 && (data[index].Seconds <= data[index - 1].Seconds)))) {
      console.log('WorkoutData contains invalid data points');
      return false;
    }
    return true;
  }


  /**
   * Finds the simple (steady state and ramp) intervals in a dataset based on
   * changes in slope.
   * @param {Array} data - The dataset containing 'Seconds' and 'FtpPercent'
   *                       attributes.
   * @param {Object} options - Additional options for calculating intervals.
   * @return {Array} - An array of intervals
   */
  function getSimpleIntervals(data, options) {
    /**
     * Determines if there is a slope change at the given point.
     * @param {number} index - The index to check for slope change.
     * @return {boolean} - True if there is a slope change, false otherwise.
     */
    function slopeChange(index) {
      const epsilon = 1e-3;
      return Math.abs(data[index].slope - data[index - 1].slope) >= epsilon;
    }

    /**
     * Determines if ramp conversion should be performed, depending on index
     * and options.
     * @param {number} index - The index value.
     * @return {boolean} - True if ramp conversion should be performed,
     *                     false otherwise.
     */
    function doRampConversion(index) {
      return options.rampConversion === 'all' ||
          (options.rampConversion === 'internal' &&
           (index > 0 && index < data.length - 1));
    }

    // Generate a new dataset with the Seconds attribute corrected and
    // an additional slope attribute, indicating the slope from that datapoint
    // to the next.
    data = data.map((dataPoint, index) => {
      const Seconds = dataPoint.Seconds / 1000; // Convert from milliSeconds
      const FtpPercent = dataPoint.FtpPercent;
      if (index === data.length - 1) {
        return {Seconds, FtpPercent};
      } else {
        const deltaPower = data[index + 1].FtpPercent - data[index].FtpPercent;
        const deltaTime = data[index + 1].Seconds - data[index].Seconds;
        const slope = deltaPower / (deltaTime / 1000); // %FTP/sec
        return {Seconds, FtpPercent, slope};
      }
    });

    /*
     * Identify workout intervals by detecting changes in the gradient
     * (slope) of FtpPercent over time.  An interval is considered to
     * end at index i (and a new one starts at the same index) if
     * there's a slope change at index i but not at index i + 1. This
     * method is based on the observation that discontinuities in
     * FtpPercent values are not present in the dataset. Instead, only
     * the FtpPercent value immediately after a discontinuity is
     * recorded, leading to an apparent early change in slope.
     *
     * For instance, consider a scenario with a steady state interval
     * at 80% FTP followed by another at 100% FTP:
     *
     * Time (ms) | FtpPercent
     * ----------------------
     * 57000     | 80
     * 58000     | 80
     * 59000     | 80
     * 60000     | 100
     * 61000     | 100
     *
     * Here, the transition between 59000ms (80% ftp) to 60000ms (100%
     * ftp) involves a slope change. Ideally, there should be an
     * additional data point at 60000ms with 80% ftp to indicate a
     * sharp change (discontinuity). With the missing point, it would
     * be clear that there is no slope change at 59000ms. There is no
     * slope change at all, but the discontinuity at 60000ms does
     * still indicate the boundary between two intervals.
     *
     * With that out of the way, a simple change of slope at the same
     * target power also marks the boundary between two intervals,
     * based on the observation that an interval has only a starting
     * power target and an ending power target, and must therefore
     * have a consistent slope throughout.
     */
    const intervals = [];
    for (let index = 1, start = 0; index < data.length; index++) {
      if (index == data.length - 1 ||
          (slopeChange(index) && !slopeChange(index + 1))) {
        const duration = data[index].Seconds - data[start].Seconds;
        let startPower = data[start].FtpPercent;
        // Ending power target must be inferred from the slope.
        let endPower = Math.round(startPower + duration * data[start].slope);
        if (doRampConversion(index)) {
          startPower = endPower = (startPower + endPower) / 2;
        }
        // Steady state intervals have a constant target power.
        // Ramp intervals do not.
        const type = startPower === endPower ? IntervalType.STEADY_STATE :
                                               IntervalType.RAMP;
        intervals.push({type, duration, startPower, endPower});
        start = index;
      }
    }
    return intervals;
  }


  /**
   * Processes the over-under intervals in the given intervals array based on
   * the provided options.
   * @param {Array} intervals - The array of intervals to process.
   * @param {Object} options - The options for processing the intervals.
   * @return {Array} - The processed intervals array.
   */
  function processOverUnders(intervals, options) {
    /**
     * Creates an over-under interval object.
     * @param {number} start - The index of the starting simple interval.
     * @param {number} end - The index of the ending simple interval.
     * @return {Object} - The over-under interval object.
     */
    function createOverUnder(start, end) {
      let onPowerSum = 0;
      let offPowerSum = 0;
      const repeat = ((end - start + 1) / 2) | 0;
      for (let index = start; index < end; index += 2) {
        onPowerSum += intervals[index].startPower;
        offPowerSum += intervals[index + 1].startPower;
      }
      return {
        type: IntervalType.OVER_UNDER,
        repeat: repeat,
        onDuration: intervals[start].duration,
        offDuration: intervals[start + 1].duration,
        onPower: onPowerSum / repeat,
        offPower: offPowerSum / repeat,
      };
    }

    /**
     * Replaces a sequence of intervals with an over-under interval.
     * @param {number} start - The index of the first interval in the sequence.
     * @param {number} end - The index of the last interval in the sequence.
     * @return {number} - The index of the over-under interval.
     */
    function replaceOverUnderSequence(start, end) {
      let length = end - start + 1;
      // For odd-length sequences, remove the first or last interval
      // before creating the over-under. First, try to avoid splitting
      // an interval. If that's not possible, split the longer interval.
      if (length % 2 !== 0) {
        if (intervals[start].duration === intervals[start + 2].duration) {
          end--;
        } else if (intervals[end].duration === intervals[end - 2].duration) {
          start++;
        } else if (intervals[start].duration - intervals[start + 2].duration >=
                   intervals[end].duration - intervals[end - 2].duration) {
          end--;
        } else {
          start++;
        }
        length--;
      }
      // Split the first interval if it's longer than the other "on" intervals
      if (intervals[start].duration !== intervals[start + 2].duration) {
        intervals.splice(start + 1, 0, intervals[start + 2]);
        intervals[start].duration -= intervals[start + 1].duration;
        start++; end++;
      }
      // Split the last interval if it's longer than the other "off" intervals
      if (intervals[end].duration !== intervals[end - 2].duration) {
        intervals.splice(end, 0, intervals[end - 2]);
        intervals[end + 1].duration -= intervals[end].duration;
      }
      const ouInterval = createOverUnder(start, end);
      intervals.splice(start, length, ouInterval);
      return start;
    }

    /**
     * Determines if two steady-state intervals have power targets that are
     * "close enough."
     * @param {number} a - The first index.
     * @param {number} b - The second index.
     * @return {boolean} - True if the intervals are close enough,
     *                     false otherwise.
     */
    function closeMatch(a, b) {
      const epsilon = options.ouConversion === 'loose' ? 3 : 0;
      return Math.abs(intervals[a].startPower -
                      intervals[b].startPower) <= epsilon;
    }

    /**
     * Locates and converts over-under sequences in the intervals array.
     * Start is the index of the first interval in the current candidate
     * sequence. End is the index of the last interval in the current
     * candidate sequence, inclusive.
     */
    function convertOverUnderSequences() {
      const minDuration = 10; // Minimum duration for an interval
      for (let index = 0, start = undefined;
        index <= intervals.length; index++) {
        let end = index - 1;
        if (intervals[index]?.type === IntervalType.STEADY_STATE) {
          if (start === undefined) {
            // Start a new sequence
            start = index;
            continue;
          }
          if (start === index - 1) {
            // No constraints on the second interval, other than STEADY_STATE.
            // Keep the sequence going.
            continue;
          }
          if (closeMatch(index, index - 2)) {
            if ((intervals[index].duration === intervals[index - 2].duration)) {
              // Current interval perfectly matches the antepenultimate
              // interval. Keep the sequence going.
              continue;
            }
            if (start === index - 2 && intervals[index - 2].duration >=
                intervals[index].duration + minDuration) {
              /*
               * The first interval doesn't match the third, but it can be split
               * into two consecutive intervals, where the latter matches
               * the third. Keep the sequence going.
               */
              continue;
            }
            if (intervals[index].duration >=
                intervals[index - 2].duration + minDuration) {
              /*
               * The current interval doesn't match the antepenultimate
               * interval, but it can be split into two consecutive intervals,
               * where the former matches the antepenultime. End the sequence.
               */
              end = index;
            }
          }
        }
        if (start !== undefined) {
          if (end - start + 1 >= 4) {
            index = replaceOverUnderSequence(start, end);
          } else {
            index = start;
          }
          start = undefined;
        }
      }
    }

    if (options.ouConversion !== 'none') {
      convertOverUnderSequences();
    }
    return intervals;
  }

  if (!validWorkoutData(data)) {
    return [];
  }
  const simpleIntervals = getSimpleIntervals(data, options);
  return processOverUnders(simpleIntervals, options);
}


/**
 * Generates a Zwift workout file based on the provided workout and options.
 * @param {Object} workout - The workout object containing details
 *                           and intervals.
 * @param {Object} options - The options object for generating the workout.
 * @return {Object} - An object containing the filename and content of the
 *                    generated Zwift workout file.
 */
function generateZwiftWorkout(workout, options) {
  /**
   * Converts HTML to plain text by removing HTML tags and fixing up
   * whitespace.
   * @param {string} html - The HTML string to be converted.
   * @return {string} - The converted plain text.
   */
  function htmlToText(html) {
    if (!html || typeof html !== 'string') {
      return '';
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let text = doc.body.textContent;
    text = text.replace(/([\.?!])([A-Z])/g, '$1 $2');
    text = text.replace(/\s+/g, ' ');
    return text;
  }

  /**
   * Converts a zone object to a tag XML string.
   * @param {Object} zone - The zone object to convert.
   * @return {string} - The tag XML string.
   */
  function zoneToTag(zone) {
    if (!zone?.Description) {
      console.log('Zone has no description');
      return '';
    }
    return `\t\t<tag name="${zone.Description}"/>`;
  }

  /**
   * Converts an interval object to an XML string representation.
   * @param {Interval} i - The interval object to convert.
   * @return {string} The string representation of the interval.
   */
  function intervalToString(i) {
  /**
   * Converts a percentage to a normalized value.
   * @param {number} percentage - The percentage to be converted.
   * @return {string} - The normalized value as a string with two
   *                    decimal places.
   */
    function normalize(percentage) {
      return (percentage / 100).toFixed(2);
    }

    switch (i.type) {
      case IntervalType.STEADY_STATE:
        return `\t\t<${i.type} Duration="${i.duration}" ` +
             `Power="${normalize(i.startPower)}"/>`;
      case IntervalType.RAMP:
        return `\t\t<${i.type} Duration="${i.duration}" ` +
             `PowerLow="${normalize(i.startPower)}" ` +
             `PowerHigh="${normalize(i.endPower)}"/>`;
      case IntervalType.OVER_UNDER:
        return `\t\t<${i.type} Repeat="${i.repeat}" ` +
             `OnDuration="${i.onDuration}" OffDuration="${i.offDuration}" ` +
             `OnPower="${normalize(i.onPower)}" ` +
             `OffPower="${normalize(i.offPower)}"/>`;
      default:
        console.log(`Unknown Zwift interval type: ${i.type}`);
        break;
    }
  }

  const details = workout?.Details;
  const name = details?.WorkoutName?.trimEnd() || 'Unnamed Workout';
  const workoutDescription = `${htmlToText(details?.WorkoutDescription)}\n`;
  const goalDescription = `${htmlToText(details?.GoalDescription)}\n`;
  const tags = details?.Zones?.map(zoneToTag).join('\n');
  const intervals = getZwiftIntervals(workout?.WorkoutData, options);
  const segments = intervals.map(intervalToString).join('\n');

  const content = `<workout_file>\n` +
    `\t<author>TrainerRoad</author>\n` +
    `\t<name>${name}</name>\n` +
    `\t<description>` +
    `<![CDATA[${workoutDescription}\n${goalDescription}]]>` +
    `</description>\n` +
    `\t<sportType>bike</sportType>\n` +
    `\t<tags>\n` +
    `${tags}\n` +
    `\t</tags>\n` +
    `\t<workout>\n` +
    `${segments}\n` +
    `\t</workout>\n` +
    `</workout_file>\n`;

  return {
    filename: `${name}.zwo`,
    content: content,
  };
}

/**
 * Downloads the ZWO file for the current workout.
 * @return {Promise<void>} A promise that resolves when the ZWO file
 *                         is downloaded successfully.
 */
async function downloadZWO() {
  /**
   * Fetches workout details from the TrainerRoad workout API.
   * @param {string} workoutId - The ID of the workout.
   * @return {Promise<Object>} - A promise that resolves to the workout details.
   * @throws {Error} - If there is an error fetching the workout details.
   */
  async function fetchWorkoutDetails(workoutId) {
    const url = `https://www.trainerroad.com/api/workoutdetails/${workoutId}`;
    const response = await fetch(url, {credentials: 'include'});
    if (!response.ok) {
      throw new Error(`Error fetching ${url}; status: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * Downloads a string as a file.
   * @param {string} content - The content string to be downloaded.
   * @param {string} filename - The name of the file to be downloaded.
   */
  function downloadStringAsFile(content, filename) {
    const blob = new Blob([content], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');

    downloadLink.href = url;
    downloadLink.download = filename;
    document.body.appendChild(downloadLink);

    downloadLink.click();

    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  }


  /**
   * Retrieves the options from storage or returns default options.
   * @return {Promise<Object>} The options object.
   */
  async function getOptions() {
    const defaultOptions = {
      rampConversion: 'none',
      ouConversion: 'strict',
    };
    const storedOptions = await chrome.storage.sync.get('options');
    const options = storedOptions.options || defaultOptions;
    const rampConversionValues = ['none', 'internal', 'all'];
    const ouConversionValues = ['strict', 'loose', 'none'];
    options.rampConversion = rampConversionValues.
        includes(options?.rampConversion) ?
          options.rampConversion : defaultOptions.rampConversion;
    options.ouConversion = ouConversionValues.
        includes(options?.ouConversion) ?
          options.ouConversion : defaultOptions.ouConversion;
    return options;
  }

  /**
   * User feedback for ZWO button processing.
   */
  function beginProcessing() {
    const zwoButton = document.getElementById('ZWO');
    zwoButton.classList.add('processing');
    zwoButton.setAttribute('aria-busy', 'true');
    zwoButton.setAttribute('aria-label', 'Processing, please wait...');
    zwoButton.setAttribute('disabled', 'true');
  }

  /**
   * User feedback for the completion of ZWO button processing.
   */
  function endProcessing() {
    const zwoButton = document.getElementById('ZWO');
    zwoButton.classList.remove('processing');
    zwoButton.removeAttribute('aria-busy');
    zwoButton.setAttribute('aria-label', 'Download ZWO file');
    zwoButton.removeAttribute('disabled');
  }

  beginProcessing();
  try {
    const options = await getOptions();
    const workoutIdMatch = document.location.href.match(/\/(\d*)[^/]*$/);
    const workoutDetails = await fetchWorkoutDetails(workoutIdMatch[1]);
    const workout = workoutDetails?.Workout;
    const zwiftWorkout = generateZwiftWorkout(workout, options);
    downloadStringAsFile(zwiftWorkout.content, zwiftWorkout.filename);
  } catch (error) {
    console.log('ZWO export failure: ', error);
  }
  endProcessing();
}

/**
 * Adds a 'ZWO' button next to the 'Open in App' button, if it
 * exists. The 'Open in App' button is impossible to identify
 * directly, because its text is affected by i18n. However, we can
 * look for the 'Schedule' button, which has a common
 * great-grandparent, and is unaffected by i18n.
 * @return {boolean} Returns true if the openInAppButton is found,
 *                   otherwise false.
 */
function modifyButtons() {
  /**
   * Returns the grandparent element of the given node.
   * @param {HTMLElement} node - The node whose grandparent is to be retrieved.
   * @return {HTMLElement|null} - The grandparent element, or null
   *                               if it doesn't exist.
   */
  function grandParentElement(node) {
    return node?.parentElement?.parentElement;
  }

  /**
   * Finds the next sibling with a button descendent starting from a given node.
   * @param {Element} startNode - The node to start the search from.
   * @return {Element|null} - The next button element, or null if not found.
   */
  function findNextSiblingButton(startNode) {
    let currentNode = startNode?.nextElementSibling;
    while (currentNode) {
      const button = currentNode.querySelector('button');
      if (button) {
        return button;
      }
      currentNode = currentNode.nextElementSibling;
    }
    return null;
  }

  const documentButtons = Array.from(document.querySelectorAll('button'));
  const scheduleButton = documentButtons.find(function(button) {
    return button.textContent.trim() === 'Schedule';
  });
  const scheduleButtonGrandparent = grandParentElement(scheduleButton);
  const openInAppButton = findNextSiblingButton(scheduleButtonGrandparent);

  if (openInAppButton) {
    const node = grandParentElement(openInAppButton);
    const clone = node.cloneNode(true);
    const clonedButton = clone.getElementsByTagName('button')[0];
    const zwoButton = document.createElement('button');
    zwoButton.textContent = zwoButton.id = 'ZWO';
    zwoButton.className = openInAppButton.className;
    zwoButton.setAttribute('aria-label', 'Download ZWO file');
    zwoButton.addEventListener('click', () => {
      downloadZWO();
    });

    clonedButton.parentNode.replaceChild(zwoButton, clonedButton);
    node.parentNode.insertBefore(clone, null);
  }
  return openInAppButton != null;
}

/**
 * Mutation observer for monitoring DOM changes.
 * @type {MutationObserver}
 */
const observer = new MutationObserver(() => {
  try {
    if (modifyButtons()) {
      observer.disconnect();
    }
  } catch (error) {
    console.log('DOM modification failed: ', error);
    observer.disconnect();
  }
});

document.addEventListener('DOMContentLoaded', function() {
  // If the buttons are not modified, start observing the DOM.
  if (!modifyButtons()) {
    observer.observe(document, {childList: true, subtree: true});
  }
});
