const IntervalType = Object.freeze({
    STEADY_STATE: 'SteadyState',
    RAMP: 'Ramp',
    OVER_UNDER: 'IntervalsT',
});

/*
 * Convert HTML content into plain text by removing HTML tags and
 * ensuring spacing between sentences.
 */
function convertHTML(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    text = temp.textContent || temp.innerHTML || '';
    return text.replace(/([\.?!])([A-Z])/g, '$1 $2');
}

/*
 * Normalize a percentage value to a decimal string formatted to two
 * decimal places.
 */
function norm(percentage) {
    const value = percentage / 100;
    return value.toFixed(2);
}

/*
 * Trigger a download of a given string as a file in the user's
 * browser.
 */
function downloadStringAsFile(contentString, filename) {
    const blob = new Blob([contentString], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);

    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/*
 * Asynchronously fetch workout details from the TrainerRoad API endpoint.
 */
async function fetchWorkoutDetails(workoutId) {
    const url = `https://www.trainerroad.com/api/workoutdetails/${workoutId}`;
    const response = await fetch(url, {credentials: 'include'});
    if (!response.ok) {
	throw new Error(`Error fetching ${url}; status: ${response.status}`);
    }
    return await response.json();
}

/*
 * Calculate the slope (i.e. delta(ftpPercent) / delta(seconds))
 * from workoutData[i] to workoutData[i + 1].
 */
function slope(workoutData, i) {
    const deltaPower = workoutData[i + 1].ftpPercent - workoutData[i].ftpPercent,
	  deltaTime = workoutData[i + 1].seconds - workoutData[i].seconds;

    return deltaPower / deltaTime;
}

/*
 * Determine if there is a slope change at workoutData[i].
 */
function slopeChange(workoutData, i) {
    // To terminate the final interval, we declare a slope change at the last data point.
    if (i + 1 == workoutData.length) {
	return true;
    }
    // No slope changes beyond the last data point.
    if (i >= workoutData.length) {
	return false;
    }
    const epsilon = 0.001,
	  slopeLeft = slope(workoutData, i - 1),
	  slopeRight = slope(workoutData, i);

    return Math.abs(slopeLeft - slopeRight) >= epsilon;
}

/*
 * The base intervals are either STEADY_STATE or RAMP intervals. We
 * will look for OVER_UNDER intervals after determining the base
 * intervals.
 */
function getBaseIntervals(workoutData) {
    let intervals = [],
	intervalStart = 0;

    for (let i = 1; i < workoutData.length; i++) {
	if (slopeChange(workoutData, i) && !slopeChange(workoutData, i + 1)) {
	    const duration = workoutData[i].seconds - workoutData[intervalStart].seconds,
		  powerLow = workoutData[intervalStart].ftpPercent,
		  powerHigh = Math.round(powerLow + duration * slope(workoutData, intervalStart)),
		  type = powerLow === powerHigh ? IntervalType.STEADY_STATE : IntervalType.RAMP;
	    intervals.push({type: type, duration: duration, powerLow: powerLow, powerHigh: powerHigh});
	    intervalStart = i;
	}
    }

    return intervals;
}

/*
 * Convert base intervals into over-under intervals where applicable.
 */
function convertOverUnders(intervals) {
    // Calculate repeat counts for alternating identical STEADY_STATE intervals
    let repeat = intervals.map(i => i.type === IntervalType.STEADY_STATE ? 1 : 0);

    for (let i = intervals.length - 3; i >= 0; i--) {
	if (intervals[i].type === IntervalType.STEADY_STATE &&
	    intervals[i].duration === intervals[i + 2].duration &&
	    intervals[i].powerLow === intervals[i + 2].powerLow) {
	    repeat[i] = repeat[i + 2] + 1;
	}
    }

    // Coalesce over-under sequences into a single OVER_UNDER interval
    for (let i = 0; i + 3 < intervals.length; i++) {
	if (repeat[i] > 1 && repeat[i + 1] > 1) {
	    let overUnder = {
		type: IntervalType.OVER_UNDER,
		Repeat: Math.min(repeat[i], repeat[i + 1]),
		onDuration: intervals[i].duration,
		offDuration: intervals[i + 1].duration,
		onPower: intervals[i].powerLow,
		offPower: intervals[i + 1].powerLow,
	    };
	    intervals.splice(i, 2 * overUnder.Repeat, overUnder);
	    repeat.splice(i, 2 * overUnder.Repeat, 0);
	}
    }
}

/*
 * TrainerRoad's workoutData.seconds is actually milliseconds; convert
 * milliseconds to seconds.
 */
function fixTime(workoutData) {
    workoutData.forEach(d => {d.seconds /= 1000;});

    return workoutData;
}

/*
 * Calculate Zwift intervals from TrainerRoad's workoutData array.
 */
function getZwiftIntervals(workoutData) {
    let intervals = getBaseIntervals(fixTime(workoutData));
    convertOverUnders(intervals);
    return intervals;
}

/*
 * Generate a Zwift tag from a TrainerRoad Zone.
 */
function zoneToTag(zone) {
    return zone.Description ? `\t\t<tag name="${zone.Description}"/>` : '';
}

/*
 * Convert a Zwift interval into an XML string.
 */
function intervalToString(i) {
    switch (i.type) {
    case IntervalType.STEADY_STATE:
	return `\t\t<${i.type} Duration="${i.duration}" Power="${norm(i.powerLow)}"/>`;
    case IntervalType.RAMP:
	return `\t\t<${i.type} Duration="${i.duration}" PowerLow="${norm(i.powerLow)}" ` +
	    `PowerHigh="${norm(i.powerHigh)}"/>`;
    case IntervalType.OVER_UNDER:
	return `\t\t<${i.type} Repeat="${i.Repeat}" OnDuration="${i.onDuration}" ` +
	    `OffDuration="${i.offDuration}" OnPower="${norm(i.onPower)}" OffPower="${norm(i.offPower)}"/>`;
    default:
	console.log(`Unknown Zwift interval type: ${i.type}`);
	break;
    }
}

/*
 * Generate a Zwift workout (filenameand XML contents) from a
 * TrainerRoad workout object
 */
function generateZwiftWorkout(workout) {
    const name = workout.Details.WorkoutName.trimEnd();
    const workoutDescription = `${convertHTML(workout.Details.WorkoutDescription)}\n`;
    const goalDescription = `${convertHTML(workout.Details.GoalDescription)}\n`;
    const tags = workout.Details.Zones.map(zoneToTag).join('\n');
    const intervals = getZwiftIntervals(workout.workoutData).map(intervalToString).join('\n');

    const content = `<workout_file>\n` +
	  `\t<author>TrainerRoad</author>\n` +
	  `\t<name>${name}</name>\n` +
	  `\t<description><![CDATA[${workoutDescription}\n${goalDescription}]]></description>\n` +
	  `\t<sportType>bike</sportType>\n` +
	  `\t<tags>\n` +
	  `${tags}\n` +
	  `\t</tags>\n` +
	  `\t<workout>\n` +
	  `${intervals}\n` +
	  `\t</workout>\n` +
	  `</workout_file>\n`;

    return {
	filename: `${name}.zwo`,
	content: content,
    }
}

/*
 * Download a .zwo file corresponding to the current TrainerRoad workout.
 */
async function downloadZWO() {
    try {
	const match = document.location.href.match(/\/(\d*)[^/]*$/);
	const workoutDetails = await fetchWorkoutDetails(match[1]);
	const workout = workoutDetails.Workout;
	const zwiftWorkout = generateZwiftWorkout(workout);
	downloadStringAsFile(zwiftWorkout.content, zwiftWorkout.filename);
    } catch (error) {
	console.error('ZWO export failure: ', error);
    }
}

/*
 * Add a 'ZWO' button next to the 'Open in App' button, if it
 * exists. Remove the 'ZWO' button if the 'Open in App' button goes
 * away.
 */
function checkAndModifyButtons() {
    // Use querySelectorAll to get all buttons, then filter them by their text content
    const allButtons = document.getElementsByTagName('button');
    const openInAppButton = Array.from(allButtons).find(button => button.textContent === 'Open in App');
    let zwoButton = document.getElementById('ZWO');

    if (openInAppButton && !zwoButton) {
	const grandParent = openInAppButton.parentElement.parentElement;
	const clone = grandParent.cloneNode(true);

	const clonedButton = clone.getElementsByTagName('button')[0];

        zwoButton = document.createElement('button');
        zwoButton.textContent = zwoButton.id = 'ZWO';
        zwoButton.className = openInAppButton.className;
        zwoButton.addEventListener('click', () => {downloadZWO()});

	clonedButton.parentNode.replaceChild(zwoButton, clonedButton);

        grandParent.parentNode.insertBefore(clone, grandParent.nextSibling);
    } else if (zwoButton && !openInAppButton) {
	const grandParent = zwoButton.parentElement.parentElement;
	grandParent.parentNode.removeChild(grandParent);
    }
}

const observer = new MutationObserver((mutations, obs) => {
    checkAndModifyButtons();
});

observer.observe(document, { childList: true, subtree: true });

checkAndModifyButtons();
