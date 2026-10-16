//Global Variable
var jsonToClipboard = "";

document.getElementById("BtnRefresh").addEventListener("click", init);
document.getElementById("BtnClear").addEventListener("click", clearAll);
document.getElementById("BtnFullScreen").addEventListener("click", openFullScreen);
document.getElementById("BtnSdkTools").addEventListener("click", openSdkTools);

function openFullScreen() {
  const url = chrome.runtime.getURL("fullscreen.html");
  if (chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}

function openSdkTools() {
  const url = chrome.runtime.getURL("settings.html");
  if (chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}

function isReservedStorageKey(key) {
  return key === "__mcp_settings__" || String(key).indexOf("__mcp_") === 0;
}

var txtAreaField = document.getElementById("atob");
txtAreaField.addEventListener("input", function () {
  var encodedString = txtAreaField.value;
  try {
    var decodedString = decodeURIComponent(escape(atob(encodedString)));
    var decodedJson = JSON.parse(decodedString);

    generateJsonViewer(decodedJson);
  } catch (e) {
    $("#json")
      .empty()
      .html('<font color="red">Error: Invalid Base64 text</font>');
    document.getElementById("json").hidden = false;
    document.getElementById("bd-clipboard").hidden = true;
    document.getElementById("jsonImg").hidden = true;
  }
});

async function getData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, function (items) {
      resolve(items);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initTooltips(root) {
  var scope = root || document;
  var nodes = scope.querySelectorAll
    ? scope.querySelectorAll('[data-bs-toggle="tooltip"]')
    : [];
  nodes.forEach(function (el) {
    var existing = bootstrap.Tooltip.getInstance(el);
    if (existing) {
      existing.dispose();
    }
    new bootstrap.Tooltip(el);
  });
}

async function init() {
  //Reset UI
  document.getElementById("jsonImg").hidden = false;
  document.getElementById("json").hidden = true;
  document.getElementById("bd-clipboard").hidden = true;
  document.getElementById("json").innerHTML = "";
  document.getElementById("atob").value = "";

  var o = await getData();

  var listOfSites = Object.keys(o).filter(function (key) {
    return !isReservedStorageKey(key);
  });

  document.getElementById("accordionExample").innerHTML = ""; //Clear for first time
  if (listOfSites.length > 0) {
    for (var l = 0; l < listOfSites.length; l++) {
      var accordionHtml = generateAccordianItems(l, listOfSites[l]);
      document.getElementById("accordionExample").appendChild(accordionHtml);
    }
  } else {
    //No sites captured
    document.getElementById("accordionExample").innerHTML = `
    <div class="alert alert-info" role="alert">
      No sites captured yet.
    </div>
    `;
  }

  function generateAccordianItems(itemNumber, hostName) {
    var tableItems = "";
    var savedItems = o[hostName];

    if (!Array.isArray(savedItems)) {
      return document.createElement("div");
    }

    var htmlBulletCounter = 1;
    for (var item = savedItems.length - 1; item >= 0; item--) {
      var key = Object.keys(savedItems[item])[0];
      var entry = savedItems[item][key] || {};
      // Keys are "<eventTime>-<capturedAt>" since 0.0.5 (plain epoch before),
      // so Number(key) is NaN for new entries.
      var tmpDate = new Date(
        Number(entry["eventTime"] || entry["datetime"] || parseInt(key, 10))
      );
      var dateSince = moment(tmpDate).fromNow();
      var savedUrlText = "";
      try {
        savedUrlText = new URL(
          decodeURIComponent(escape(entry["url"] || ""))
        ).href;
      } catch (_) {
        savedUrlText = entry["url"] || "";
      }

      var payload = entry["payload"];
      var payloadStr = JSON.stringify(payload);
      var encodedString = btoa(unescape(encodeURIComponent(payloadStr)));

      // Support legacy typo key "statusCode;" from older builds
      var statusCode =
        entry["statusCode"] !== undefined
          ? entry["statusCode"]
          : entry["statusCode;"];
      var responseStatusAlertCSS =
        statusCode >= 200 && statusCode < 400
          ? "alert alert-success"
          : "alert alert-danger";

      var itemClass =
        htmlBulletCounter <= 5 ? "ck-item-show" : "ck-item-hide";
      tableItems += `<div class="${itemClass} ck-itemNumber-${htmlBulletCounter} accordion-body ${responseStatusAlertCSS} text-start" style="padding-top: 0px !important; padding-bottom: 0px !important" >${htmlBulletCounter}) 
      ${escapeHtml(dateSince)}
      <span
          title="${escapeHtml(tmpDate)}"
          data-bs-title="${escapeHtml(tmpDate)}"
          data-bs-toggle="tooltip"
          data-bs-placement="right"
          >
          <sup><img height="12px" width="12px" src="./images/clock.png"/></sup>
      </span>
      <span class="badge ${
        statusCode >= 200 && statusCode < 400 ? "bg-success" : "bg-danger"
      }" title="${escapeHtml(savedUrlText)}">${
        statusCode == null ? "ERR" : escapeHtml(statusCode)
      }</span>
      <a class="btn btn-link ck-viewEncodedString" data-encoded-string="${escapeHtml(
        encodedString
      )}" data-accordion-id="${
        "collapse_" + itemNumber
      }" href="#json">View</a></div>`;
      htmlBulletCounter++;
    }

    var showMoreDiv =
      savedItems.length > 5
        ? `<a class="ck-showMore" href="#">Show All</a>`
        : "";
    var tmpHtml = `
      <h2 class="accordion-header" id="heading_${itemNumber}">
        <button
          type="button"
          class="accordion-button collapsed"
          data-bs-toggle="collapse"
          data-bs-target="#collapse_${itemNumber}"
          aria-expanded="false"
          aria-controls="collapse_${itemNumber}"
        >
          ${escapeHtml(hostName)}
        </button>
      </h2>
      <div
        class="accordion-collapse collapse"
        id="collapse_${itemNumber}"
        data-bs-parent="#accordionExample"
        aria-labelledby="heading_${itemNumber}"
      >
        <div class="accordion-body text-start">
          ${tableItems}
          ${showMoreDiv}
        </div>
      </div>
    `;

    var accordionHtml = document.createElement("div");
    accordionHtml.className = "accordion-item mb-3";
    accordionHtml.innerHTML = tmpHtml;

    return accordionHtml;
  }

  document.querySelectorAll(".ck-showMore").forEach(function (item) {
    item.addEventListener("click", function (e) {
      e.preventDefault();
      var body = item.closest(".accordion-body");
      if (!body) {
        return;
      }
      body
        .querySelectorAll(".ck-item-hide")
        .forEach(function (hiddenItem) {
          hiddenItem.classList.add("ck-item-show");
          hiddenItem.classList.remove("ck-item-hide");
        });
      item.classList.add("ck-item-hide");
    });
  });

  document.querySelectorAll(".ck-viewEncodedString").forEach(function (item) {
    item.addEventListener("click", function (e) {
      e.preventDefault();
      var encoded = item.getAttribute("data-encoded-string") || "";
      $("#atob").val(encoded);
      document.getElementById("atob").dispatchEvent(new Event("input"));

      var accordionId = item.getAttribute("data-accordion-id");
      var collapseEl = accordionId
        ? document.getElementById(accordionId)
        : null;
      if (collapseEl && collapseEl.classList.contains("show")) {
        var instance = bootstrap.Collapse.getInstance(collapseEl);
        if (!instance) {
          instance = new bootstrap.Collapse(collapseEl, { toggle: false });
        }
        instance.hide();
      }

      document.getElementById("json").scrollIntoView({ behavior: "smooth" });
    });
  });

  initTooltips(document.getElementById("accordionExample"));
}

async function clearAll() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "MCP_CLEAR_EVENTS_KEEP_SETTINGS" },
      function () {
        init();
        resolve(true);
      }
    );
  });
}
init();

//Json viewer
function generateJsonViewer(jsonObj) {
  jsonToClipboard = jsonObj;
  var jsonViewer = new JSONViewer();

  document.querySelector("#json").hidden = false;
  document.querySelector("#bd-clipboard").hidden = false;
  document.querySelector("#jsonImg").hidden = true;
  document.querySelector("#json").innerHTML = "";
  document.querySelector("#json").appendChild(jsonViewer.getContainer());

  jsonViewer.showJSON(jsonObj); //Show all
}

// https://getbootstrap.com/docs/4.0/components/tooltips/#methods
$(function () {
  initTooltips(document);
});

function downloadJson(data, filename) {
  var blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);
}

$("#BtnCopyJson").on("click", function () {
  var tipEl = document.querySelector(".btn-clipboard-tooltip-span");
  if (tipEl) {
    tipEl.setAttribute("data-bs-title", "Copied!");
    var tip = bootstrap.Tooltip.getOrCreateInstance(tipEl);
    tip.setContent({ ".tooltip-inner": "Copied!" });
    tip.show();
  }
  navigator.clipboard.writeText(JSON.stringify(jsonToClipboard));
});
$("#BtnDownloadJson").on("click", function (e) {
  e.preventDefault();
  e.stopPropagation();
  if (!jsonToClipboard) {
    return;
  }
  var stamp = moment().format("YYYYMMDD-HHmmss");
  downloadJson(jsonToClipboard, "mcp-event-" + stamp + ".json");
  var tipEl = this;
  var span = tipEl.querySelector("span");
  var original = span ? span.textContent : tipEl.textContent;
  if (span) {
    span.textContent = " Saved ";
  } else {
    tipEl.textContent = "Saved";
  }
  setTimeout(function () {
    if (span) {
      span.textContent = original;
    } else {
      tipEl.textContent = original;
    }
  }, 1200);
});
$("#BtnCopyJson").on("mouseover", function () {
  var tipEl = document.querySelector(".btn-clipboard-tooltip-span");
  if (tipEl) {
    tipEl.setAttribute("data-bs-title", "Copy to clipboard!");
    var tip = bootstrap.Tooltip.getInstance(tipEl);
    if (tip) {
      tip.setContent({ ".tooltip-inner": "Copy to clipboard!" });
    }
  }
});
