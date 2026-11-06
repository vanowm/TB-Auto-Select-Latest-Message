"use strict";
/* exported ASLMSettings */

const ASLMSettings = {
	defaults: { sel: 1, selForce: false, focus: true },

	normalize: (values = {}) =>
	{
		if (!values || typeof values !== "object" || Array.isArray(values)) values = {};
		return {
			sel: [0, 1, 2].includes(values.sel) ? values.sel : 1,
			selForce: typeof values.selForce === "boolean" ? values.selForce : false,
			focus: typeof values.focus === "boolean" ? values.focus : true,
		};
	},
};
