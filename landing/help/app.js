(function () {
	"use strict";

	var search = document.getElementById("helpSearch");
	var sections = Array.prototype.slice.call(document.querySelectorAll(".help-section"));
	var links = Array.prototype.slice.call(document.querySelectorAll(".help-sidebar a[href^='#']"));
	var mobileToc = document.getElementById("mobileTocSelect");
	var empty = document.getElementById("searchEmpty");

	function normalize(value) {
		return (value || "").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
	}

	function applySearch() {
		var query = normalize(search.value);
		var visible = 0;
		sections.forEach(function (section) {
			var match = !query || normalize(section.textContent).includes(query);
			section.classList.toggle("hidden", !match);
			visible += match ? 1 : 0;
		});
		empty.classList.toggle("visible", visible === 0);
	}

	search.addEventListener("input", applySearch);
	document.addEventListener("keydown", function (event) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			search.focus();
			search.select();
		}
		if (event.key === "Escape" && document.activeElement === search) {
			search.value = "";
			applySearch();
			search.blur();
		}
	});

	if (mobileToc) {
		mobileToc.addEventListener("change", function () {
			var target = document.getElementById(mobileToc.value);
			if (target) target.scrollIntoView({ block: "start" });
		});
	}

	if ("IntersectionObserver" in window) {
		var observer = new IntersectionObserver(
			function (entries) {
				var current = entries
					.filter(function (entry) {
						return entry.isIntersecting;
					})
					.sort(function (left, right) {
						return left.boundingClientRect.top - right.boundingClientRect.top;
					})[0];
				if (!current) return;
				links.forEach(function (link) {
					link.classList.toggle("active", link.getAttribute("href") === "#" + current.target.id);
				});
				if (mobileToc) mobileToc.value = current.target.id;
			},
			{ rootMargin: "-20% 0px -68% 0px" },
		);
		sections.forEach(function (section) {
			observer.observe(section);
		});
	}

	document.getElementById("printManual").addEventListener("click", function () {
		window.print();
	});
})();
