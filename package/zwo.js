const IntervalType = Object.freeze({
    STEADY_STATE: 'SteadyState',
    RAMP: 'Ramp',
    OVER_UNDER: 'IntervalsT',
});

function convertHTML(html) {
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return temp.textContent || temp.innerHTML || "";
}

function norm(percentage) {
    const value = percentage / 100;
    return value.toFixed(2);
}

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

async function fetchWorkoutDetails(workoutId) {
    const url = `https://www.trainerroad.com/api/workoutdetails/${workoutId}`;
    const response = await fetch(url, {credentials: 'include'});
    if (!response.ok) {
	throw new Error(`Error fetching ${url}; status: ${response.status}`);
    }
    return await response.json();
}

function extrapolatePower(start, end, time, extendedTime) {
    const deltaPerSecond = (end - start) / time;
    return Math.round(start + extendedTime * deltaPerSecond);
}

function createBaseInterval(type, duration, powerLow, powerHigh) {
    return {
	Type: type,
	Duration: duration,
	PowerLow: powerLow,
	PowerHigh: powerHigh,
    }
}

function getBaseIntervals(workout) {
    let baseIntervals = [];

    workout.intervalData.forEach(function(id) {
	// Skip the 'Workout' interval, which spans the entire workout
	if (id.Name !== 'Workout') {
	    const duration = id.End - id.Start;
	    if (duration > 0) {
		// Note that workoutData.seconds is actually milliseconds
		const penultimate = workout.workoutData.find(wd => wd.seconds === (id.End - 1) * 1000);
		const powerLow = id.StartTargetPowerPercent;
		const powerHigh = !penultimate || duration < 2 ? powerLow :
		      extrapolatePower(powerLow, penultimate.ftpPercent, duration - 1, duration);
		const type = powerLow === powerHigh ? IntervalType.STEADY_STATE : IntervalType.RAMP;
		baseIntervals.push(createBaseInterval(type, duration, powerLow, powerHigh));
	    }
	}
    });

    return baseIntervals;
}

function mergeIntervals(intervals) {
    // Merge adjacent STEADY_STATE intervals with the same power (example: 18127-recess-4)
    for (let i = intervals.length - 2; i >= 0; i--) {
	if (intervals[i].Type === IntervalType.STEADY_STATE &&
	    intervals[i + 1].Type === IntervalType.STEADY_STATE &&
	    intervals[i].PowerLow === intervals[i + 1].PowerLow) {
	    intervals[i].Duration += intervals[i + 1].Duration;
	    intervals.splice(i + 1, 1);
	}
    }
}

// Find over-under intervals (example: 5516-mono)
function convertOverUnders(intervals) {
    // Calculate repeat counts for alternating identical STEADY_STATE intervals
    let repeat = intervals.map(i => i.Type === IntervalType.STEADY_STATE ? 1 : 0);

    for (let i = intervals.length - 3; i >= 0; i--) {
	if (intervals[i].Type === IntervalType.STEADY_STATE &&
	    intervals[i].Duration === intervals[i + 2].Duration &&
	    intervals[i].PowerLow === intervals[i + 2].PowerLow) {
	    repeat[i] = repeat[i + 2] + 1;
	}
    }

    // Coalesce over-under sequences into a single OVER_UNDER interval
    for (let i = 0; i + 3 < intervals.length; i++) {
	if (repeat[i] > 1 && repeat[i + 1] > 1) {
	    let overUnder = {
		Type: IntervalType.OVER_UNDER,
		Repeat: Math.min(repeat[i], repeat[i + 1]),
		OnDuration: intervals[i].Duration,
		OffDuration: intervals[i + 1].Duration,
		OnPower: intervals[i].PowerLow,
		OffPower: intervals[i + 1].PowerLow,
	    };
	    intervals.splice(i, 2 * overUnder.Repeat, overUnder);
	    repeat.splice(i, 2 * overUnder.Repeat, 0);
	}
    }
}

function getZwiftIntervals(workout) {
    let intervals = getBaseIntervals(workout);
    mergeIntervals(intervals);
    convertOverUnders(intervals);
    return intervals;
}

function generateZwiftWorkout(workout) {
    const name = workout.Details.WorkoutName.trimEnd();
    const workoutDescription = `${convertHTML(workout.Details.WorkoutDescription)}\n`;
    const goalDescription = `${convertHTML(workout.Details.GoalDescription)}\n`;

    let tags = '';

    workout.Details?.Zones?.forEach(function(z) {
	if (z.Description) {
	    tags += `\n\t\t<tag name="${z.Description}"/>`;
	}
    });

    let content = `<workout_file>\n` +
	`\t<author>TrainerRoad</author>\n` +
	`\t<name>${name}</name>\n` +
	`\t<description><![CDATA[${workoutDescription}\n${goalDescription}]]></description>\n` +
	`\t<sportType>bike</sportType>\n` +
	`\t<tags>${tags}\n\t</tags>\n` +
	`\t<workout>\n`;

    getZwiftIntervals(workout).forEach(function(i) {
	content += `\t\t<${i.Type} `;
	switch (i.Type) {
	case IntervalType.STEADY_STATE:
	    content += `Duration="${i.Duration}" Power="${norm(i.PowerLow)}"/>\n`;
	    break;
	case IntervalType.RAMP:
	    content += `Duration="${i.Duration}" PowerLow="${norm(i.PowerLow)}" PowerHigh="${norm(i.PowerHigh)}"/>\n`;
	    break;
	case IntervalType.OVER_UNDER:
	    content += `Repeat="${i.Repeat}" OnDuration="${i.OnDuration}" OffDuration="${i.OffDuration}" ` +
		`OnPower="${norm(i.OnPower)}" OffPower="${norm(i.OffPower)}"/>\n`;
	    break;
	default:
	    console.log(`Unknown Zwift interval type: ${i.Type}`);
	    break;
	}
    });

    content += `\t</workout>\n</workout_file>`;

    return {
	filename: `${name}.zwo`,
	content: content,
    }
}

async function downloadZWO(workoutId) {
    try {
	const workoutDetails = await fetchWorkoutDetails(workoutId);
	const workout = workoutDetails.Workout;
	const zwiftWorkout = generateZwiftWorkout(workout);
	downloadStringAsFile(zwiftWorkout.content, zwiftWorkout.filename);
    } catch (error) {
	console.error('ZWO export failure: ', error);
    }
}

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
        zwoButton.addEventListener('click', function() {
	    const workoutId = document.location.href.split('/').pop().split('-')[0];
	    downloadZWO(workoutId);
        });

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
