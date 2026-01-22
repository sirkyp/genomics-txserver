const {CodeSystemProvider} = require("../cs/cs-api");
const {Extensions} = require("./extensions");
const {div} = require("../../library/html");
const {CONSTRAINT} = require("sqlite3");

/**
 * @typedef {Object} TerminologyLinkResolver
 * @property {function(OperationContext, string, string=): {description: string, link: string}|null} resolveURL
 *   Given a URL and optional version, returns description and link, or null if not found
 * @property {function(OperationContext, string, string, string=): {display: string, link: string}|null} resolveCode
 *   Given a URL, code, and optional version, returns display and link, or null if not found
 */

class Renderer {

  constructor(opContext, linkResolver = null) {
    this.opContext = opContext;
    this.linkResolver = linkResolver;
  }

  displayCoded(...args) {
    if (args.length === 1) {
      const arg = args[0];
      if (arg.systemUri !== undefined && arg.version !== undefined && arg.code !== undefined && arg.display !== undefined) {
        // It's a Coding
        return this.displayCodedCoding(arg);
      } else if (arg.coding !== undefined) {
        // It's a CodeableConcept
        return this.displayCodedCodeableConcept(arg);
      } else if (arg.systemUri !== undefined && arg.version !== undefined) {
        // It's a CodeSystemProvider
        return this.displayCodedProvider(arg);
      } else if (arg instanceof CodeSystemProvider) {
        let cs = arg;
        return cs.system() + "|" + cs.version();
      }
    } else if (args.length === 2) {
      return this.displayCodedSystemVersion(args[0], args[1]);
    } else if (args.length === 3) {
      return this.displayCodedSystemVersionCode(args[0], args[1], args[2]);
    } else if (args.length === 4) {
      return this.displayCodedSystemVersionCodeDisplay(args[0], args[1], args[2], args[3]);
    }
    throw new Error('Invalid arguments to renderCoded');
  }

  displayCodedProvider(system) {
    let result = system.systemUri + '|' + system.version;
    if (system.sourcePackage) {
      result = result + ' (from ' + system.sourcePackage + ')';
    }
    return result;
  }

  displayCodedSystemVersion(system, version) {
    if (!version) {
      return system;
    } else {
      return system + '|' + version;
    }
  }

  displayCodedSystemVersionCode(system, version, code) {
    return this.displayCodedSystemVersion(system, version) + '#' + code;
  }

  displayCodedSystemVersionCodeDisplay(system, version, code, display) {
    return this.displayCodedSystemVersionCode(system, version, code) + ' ("' + display + '")';
  }

  displayCodedCoding(code) {
    return this.displayCodedSystemVersionCodeDisplay(code.systemUri, code.version, code.code, code.display);
  }

  displayCodedCodeableConcept(code) {
    let result = '';
    for (const c of code.coding) {
      if (result) {
        result = result + ', ';
      }
      result = result + this.displayCodedCoding(c);
    }
    return '[' + result + ']';
  }

  displayValueSetInclude(inc) {
    let result;
    if (inc.systemUri) {
      result = '(' + inc.systemUri + ')';
      if (inc.hasConcepts) {
        result = result + '(';
        let first = true;
        for (const cc of inc.concepts) {
          if (first) {
            first = false;
          } else {
            result = result + ',';
          }
          result = result + cc.code;
        }
        result = result + ')';
      }
      if (inc.hasFilters) {
        result = result + '(';
        let first = true;
        for (const ci of inc.filters) {
          if (first) {
            first = false;
          } else {
            result = result + ',';
          }
          result = result + ci.prop + ci.op + ci.value;
        }
        result = result + ')';
      }
    } else {
      result = '(';
      let first = true;
      for (const s of inc.valueSets || []) {
        if (first) {
          first = false;
        } else {
          result = result + ',';
        }
        result = result + '^' + s;
      }
      result = result + ')';
    }
    return result;
  }

  async renderMetadataTable(res, tbl) {
    this.renderMetadataVersion(res, tbl);
    await this.renderMetadataProfiles(res, tbl);
    this.renderMetadataTags(res, tbl);
    this.renderMetadataLabels(res, tbl);
    this.renderMetadataLastUpdated(res, tbl);
    this.renderMetadataSource(res, tbl);
    this.renderProperty(tbl, 'TEST_PLAN_LANG', res.language);
    this.renderProperty(tbl, 'GENERAL_DEFINING_URL', res.url);
    this.renderProperty(tbl, 'GENERAL_VER', res.version);
    this.renderProperty(tbl, 'GENERAL_NAME', res.name);
    this.renderProperty(tbl, 'GENERAL_TITLE', res.title);
    this.renderProperty(tbl, 'GENERAL_STATUS', res.status);
    this.renderPropertyMD(tbl, 'GENERAL_DEFINITION', res.description);
    this.renderProperty(tbl, 'CANON_REND_PUBLISHER', res.publisher);
    this.renderProperty(tbl, 'CANON_REND_COMMITTEE', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-wg'));
    this.renderProperty(tbl, 'GENERAL_COPYRIGHT', res.copyright);
    this.renderProperty(tbl, 'EXT_FMM_LEVEL', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm'));
    this.renderProperty(tbl, 'PAT_PERIOD', res.effectivePeriod);

    if (res.content === 'supplement' && res.supplements) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('CODESYSTEM_SUPPLEMENTS'));
      await this.renderLink(tr.td(), res.supplements);
    }

    if (res.valueSet) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_VALUESET'));
      await this.renderLink(tr.td(), res.valueSet);
    }
  }

  async renderMetadataProfiles(res, tbl) {
    if (res.meta?.profile) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.profile.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.profile) {
          await this.renderLink(ul.li(), u);
        }
      } else {
        await this.renderLink(tr.td(), res.meta.profile[0]);
      }
    }
  }

  renderMetadataTags(res, tbl) {
    if (res.meta?.tag) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.tag.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.tag) {
          this.renderCoding(ul.li(), u);
        }
      } else {
        this.renderCoding(tr.td(), res.meta.tag[0]);
      }
    }
  }

  renderMetadataLabels(res, tbl) {
    if (res.meta?.label) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.label.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.label) {
          this.renderCodin(ul.li(), u);
        }
      } else {
        this.renderCoding(tr.td(), res.meta.label[0]);
      }
    }
  }

  renderMetadataVersion(res, tbl) {
    if (res.meta?.version) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_VER'));
      tr.td().tx(res.meta.version);
    }
  }

  renderMetadataLastUpdated(res, tbl) {
    if (res.meta?.version) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_UPDATED'));
      tr.td().tx(this.displayDate(res.meta.version));
    }
  }

  renderProperty(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        tr.td().tx(value);
      }
    }
  }

  renderPropertyMD(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        tr.td().markdown(value);
      }
    }
  }

  renderMetadataSource(res, tbl) {
    if (res.meta?.source) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_INFO_SOURCE'));
      tr.td().tx(res.meta.source);
    }
  }

  async renderLink(x, uri) {
    const result = this.linkResolver ? await this.linkResolver.resolveURL(this.opContext, uri) : null;
    if (result) {
      x.ah(result.link).tx(result.description);
    } else {
      x.code().tx(uri);
    }
  }

  renderLinkComma(x, uri) {
    let {desc, url} = this.linkResolver ? this.linkResolver.resolveURL(this.opContext, uri) : null;
    if (url) {
      x.commaItem(desc, url);
    } else {
      x.commaItem(uri);
    }
  }


  async renderCoding(x, coding) {
    let {
      desc,
      url
    } = this.linkResolver ? await this.linkResolver.resolveCode(this.opContext, coding.system, coding.version, coding.code) : null;
    if (url) {
      x.ah(url).tx(desc);
    } else {
      x.code(coding.code);
    }
  }

  translate(msgId) {
    return this.opContext.i18n.formatPhrase(msgId, this.opContext.langs, []);
  }

  translatePlural(num, msgId) {
    return this.opContext.i18n.formatPhrasePlural(msgId, this.opContext.langs, num,[]);
  }

  async renderValueSet(vs) {
    if (vs.json) {
      vs = vs.json;
    }

    let div_ = div();
    div_.h2().tx("Properties");
    await this.renderMetadataTable(vs, div_.table("grid"));
    if (vs.compose) {
      div_.h2().tx("Logical Definition");
      await this.renderCompose(vs, div_.table("grid"));
    }
    if (vs.expansion) {
      div_.h2().tx("Expansion");
      await this.renderExpansion(div_.table("grid"));
    }

    return div_.toString();
  }

  async renderCodeSystem(cs) {
    if (cs.json) {
      cs = cs.json;
    }

    let div_ = div();

    // Metadata table
    div_.h3().tx("Properties");
    await this.renderMetadataTable(cs, div_.table("grid"));

    // Code system properties
    const hasProps = this.generateProperties(div_, cs);

    // Filters
    this.generateFilters(div_, cs);

    // Concepts
    await this.generateCodeSystemContent(div_, cs, hasProps);

    return div_.toString();
  }

  async renderCompose(vs, x) {
    let supplements = Extensions.list(vs, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement');
    if (supplements && supplements.length > 0) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_NEEDS_SUPPL'));
      p.tx(" ");
      p.startCommaList("and");
      for (let ext of supplements) {
        this.renderLinkComma(p, ext);
      }
      p.stopCommaList();
      p.tx(".");
    }
    let parameters = Extensions.list(vs, 'http://hl7.org/fhir/tools/StructureDefinition/valueset-parameter');
    if (parameters && parameters.length > 0) {
      x.para().b().tx("This ValueSet has parameters");
      const tbl = x.table("grid");
      const tr = tbl.tr();
      tr.th().tx("Name");
      tr.th().tx("Documentation");
      for (let ext of parameters) {
        const tr = tbl.tr();
        tr.td().tx(Extensions.readValue(ext, "name"));
        tr.td().markdown(Extensions.readValue(ext, "documentation"));
      }
    }
    let comp = vs.compose;
    if (comp.include) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_RULES_INC'));
      let ul = x.ul();
      for (let inc of comp.include) {
        await this.renderInclude(ul.li(), inc);
      }
    }
    if (comp.exclude) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_RULES_EXC'));
      let ul = x.ul();
      for (let inc of comp.exclude) {
        await this.renderInclude(ul.li(), inc);
      }
    }
  }

  async renderInclude(li, inc) {
    if (inc.system) {
      if (!inc.concept && !inc.filter) {
        li.tx(this.translate('VALUE_SET_ALL_CODES_DEF')+" ");
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
      } else if (inc.concept) {
        li.tx(this.translate('VALUE_SET_THESE_CODES_DEF'));
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
        li.tx(":");
        const ul = li.ul();
        for (let c of inc.concept) {
          const li = ul.li();
          const link = this.linkResolver ? this.linkResolver.resolveCode(this.opContext, inc.system, inc.version, c.code) : null;
          if (link) {
            li.ah(link.link).tx(c.code);
          } else {
            li.tx(c.code);
          }
          if (c.display) {
            li.tx(": "+c.display);
          } else if (link) {
            li.span("opaque: 0.5").tx(": "+link.description);
          }
        }
      } else {
        li.tx(this.translate('VALUE_SET_CODES_FROM'));
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
        li.tx(" "+ this.translate('VALUE_SET_WHERE')+" ");
        li.startCommaList("and");
        for (let f of inc.filter) {
          if (f.op == 'exists') {
            if (f.value == "true") {
              li.commaItem(f.property+" "+ this.translate('VALUE_SET_EXISTS'));
            } else {
              li.commaItem(f.property+" "+ this.translate('VALUE_SET_DOESNT_EXIST'));
            }
          } else {
            li.commaItem(f.property + " " + f.op + " ");
            const loc = this.linkResolver ? this.linkResolver.resolveCode(this.opContext, inc.system, inc.version, f.value) : null;
            if (loc) {
              li.ah(loc.link).tx(loc.description);
            } else {
              li.tx(f.value);
            }
          }
        }
        li.stopCommaList();
      }
    } else {
      li.tx(this.translatePlural(inc.valueSet.length, 'VALUE_SET_RULES_INC'));
      li.startCommaList("and");
      for (let vs of inc.valueSet) {
        this.renderLinkComma(li, vs);
      }
      li.stopCommaList();
    }
  }

  generateProperties(x, cs) {
    if (!cs.property || cs.property.length === 0) {
      return false;
    }

    // Check what columns we need
    let hasURI = false;
    let hasDescription = false;

    for (const p of cs.property) {
      hasURI = hasURI || !!p.uri;
      hasDescription = hasDescription || !!p.description;
    }

    x.para().b().tx(this.translate('GENERAL_PROPS'));
    x.para().tx(this.translate('CODESYSTEM_PROPS_DESC'));

    const tbl = x.table("grid");
    const tr = tbl.tr();
    tr.th().tx(this.translate('GENERAL_CODE'));
    if (hasURI) {
      tr.th().tx(this.translate('GENERAL_URI'));
    }
    tr.th().tx(this.translate('GENERAL_TYPE'));
    if (hasDescription) {
      tr.th().tx(this.translate('GENERAL_DESC'));
    }

    for (const p of cs.property) {
      const row = tbl.tr();
      row.td().tx(p.code);
      if (hasURI) {
        row.td().tx(p.uri || '');
      }
      row.td().tx(p.type || '');
      if (hasDescription) {
        row.td().tx(p.description || '');
      }
    }

    return true;
  }

  generateFilters(x, cs) {
    if (!cs.filter || cs.filter.length === 0) {
      return;
    }

    x.para().b().tx(this.translate('CODESYSTEM_FILTERS'));

    const tbl = x.table("grid");
    const tr = tbl.tr();
    tr.th().tx(this.translate('GENERAL_CODE'));
    tr.th().tx(this.translate('GENERAL_DESC'));
    tr.th().tx(this.translate('CODESYSTEM_FILTER_OP'));
    tr.th().tx(this.translate('GENERAL_VALUE'));

    for (const f of cs.filter) {
      const row = tbl.tr();
      row.td().tx(f.code);
      row.td().tx(f.description || '');
      row.td().tx(f.operator ? f.operator.join(' ') : '');
      row.td().tx(f.value || '');
    }
  }

  async generateCodeSystemContent(x, cs, hasProps) {
    if (hasProps) {
      x.para().b().tx(this.translate('CODESYSTEM_CONCEPTS'));
    }

    const p = x.para();
    p.startScript("csc");
    p.param("cs").code().tx(cs.url);
    this.makeCasedParam(p.param("cased"), cs, cs.caseSensitive);
    this.makeHierarchyParam(p.param("h"), cs, cs.hierarchyMeaning);
    p.paramValue("code-count", this.countConcepts(cs.concept));
    p.execScript(this.sentenceForContent(cs.content, cs));
    p.closeScript();

    if (cs.content === 'not-present') {
      return;
    }

    if (!cs.concept || cs.concept.length === 0) {
      return;
    }

    // Determine table columns needed
    const columnInfo = this.analyzeConceptColumns(cs);

    // Build the concepts table
    const tbl = x.table("codes");

    // Header row
    const headerRow = tbl.tr();
    if (columnInfo.hasHierarchy) {
      headerRow.th().tx(this.translate('CODESYSTEM_LVL'));
    }
    headerRow.th().tx(this.translate('GENERAL_CODE'));
    if (columnInfo.hasDisplay) {
      headerRow.th().tx(this.translate('GENERAL_DISPLAY'));
    }
    if (columnInfo.hasDefinition) {
      headerRow.th().tx(this.translate('GENERAL_DEFINITION'));
    }
    if (columnInfo.hasDeprecated) {
      headerRow.th().tx(this.translate('CODESYSTEM_DEPRECATED'));
    }

    // Property columns
    for (const prop of columnInfo.properties) {
      headerRow.th().tx(this.getDisplayForProperty(prop) || prop.code);
    }

    // Render concepts recursively
    for (const concept of cs.concept) {
      await this.addConceptRow(tbl, concept, 0, cs, columnInfo);
    }
  }

  makeCasedParam(x, cs, caseSensitive) {
    if (caseSensitive) {
      let s = caseSensitive ? "case-sensitive" : "case-insensitive";
      x.tx(s);
    } else {
      x.tx("");
    }
  }

  makeHierarchyParam(x, cs, hm) {
    if (hm) {
      let s = hm; // look it up?
      x.tx(" "+this.translate('CODE_SYS_IN_A_HIERARCHY', [s]));
    } else if ((cs.concept || []).find(c => (c.concept || []).length > 0)) {
      x.tx(" "+ this.translate('CODE_SYS_UNDEF_HIER'));
    }
  }

  analyzeConceptColumns(cs) {
    const info = {
      hasHierarchy: false,
      hasDisplay: false,
      hasDefinition: false,
      hasDeprecated: false,
      hasComment: false,
      properties: []
    };

    // Check which properties are actually used
    const usedProperties = new Set();

    const analyzeConceptList = (concepts) => {
      for (const c of concepts) {
        if (c.display && c.display !== c.code) {
          info.hasDisplay = true;
        }
        if (c.definition) {
          info.hasDefinition = true;
        }
        if (c.concept && c.concept.length > 0) {
          info.hasHierarchy = true;
          analyzeConceptList(c.concept);
        }

        // Check for deprecated
        if (this.isDeprecated(c)) {
          info.hasDeprecated = true;
        }

        // Track used properties
        if (c.property) {
          for (const prop of c.property) {
            usedProperties.add(prop.code);
          }
        }
      }
    };

    analyzeConceptList(cs.concept || []);

    // Filter to properties that are actually used
    if (cs.property) {
      for (const prop of cs.property) {
        if (usedProperties.has(prop.code) && this.showPropertyInTable(prop)) {
          info.properties.push(prop);
        }
      }
    }

    return info;
  }

  showPropertyInTable(prop) {
    // Skip certain internal properties
    const skipCodes = ['status', 'inactive', 'deprecated', 'notSelectable'];
    return !skipCodes.includes(prop.code);
  }

  getDisplayForProperty(prop) {
    // Could look up a display name for well-known properties
    return prop.description || prop.code;
  }

  isDeprecated(concept) {
    if (concept.property) {
      for (const prop of concept.property) {
        if ((prop.code === 'status' && prop.valueCode === 'deprecated') ||
            (prop.code === 'deprecated' && prop.valueBoolean === true) ||
            (prop.code === 'inactive' && prop.valueBoolean === true)) {
          return true;
        }
      }
    }
    return false;
  }

  async addConceptRow(tbl, concept, level, cs, columnInfo) {
    const tr = tbl.tr();

    // Apply styling for deprecated concepts
    if (this.isDeprecated(concept)) {
      tr.style("background-color: #ffeeee");
    }

    // Level column
    if (columnInfo.hasHierarchy) {
      tr.td().tx(String(level + 1));
    }

    // Code column
    const codeTd = tr.td();
    if (level > 0) {
      codeTd.tx('\u00A0'.repeat(level * 2)); // Non-breaking spaces for indentation
    }

    // Link code if it's a supplement
    if (cs.content === 'supplement' && cs.supplements) {
      const link = this.linkResolver ?
          await this.linkResolver.resolveCode(this.opContext, cs.supplements, null, concept.code) : null;
      if (link) {
        codeTd.ah(link.link).tx(concept.code);
      } else {
        codeTd.tx(concept.code);
      }
    } else {
      codeTd.code().tx(concept.code);
    }
    codeTd.an(concept.code);

    // Display column
    if (columnInfo.hasDisplay) {
      tr.td().tx(concept.display || '');
    }

    // Definition column
    if (columnInfo.hasDefinition) {
      tr.td().tx(concept.definition || '');
    }

    // Deprecated column
    if (columnInfo.hasDeprecated) {
      const td = tr.td();
      if (this.isDeprecated(concept)) {
        td.tx(this.translate('CODESYSTEM_DEPRECATED_TRUE'));

        // Check for replacement
        const replacedBy = this.getPropertyValue(concept, 'replacedBy');
        if (replacedBy) {
          td.tx(' ' + this.translate('CODESYSTEM_REPLACED_BY') + ' ');
          td.code().tx(replacedBy);
        }
      }
    }

    // Property columns
    for (const prop of columnInfo.properties) {
      const td = tr.td();
      const values = this.getPropertyValues(concept, prop.code);

      let first = true;
      for (const val of values) {
        if (!first) {
          td.tx(', ');
        }
        first = false;

        await this.renderPropertyValue(td, val, prop, cs);
      }
    }

    // Recurse for child concepts
    if (concept.concept) {
      for (const child of concept.concept) {
        await this.addConceptRow(tbl, child, level + 1, cs, columnInfo);
      }
    }
  }

  getPropertyValue(concept, code) {
    if (!concept.property) return null;
    const prop = concept.property.find(p => p.code === code);
    return prop ? this.extractPropertyValue(prop) : null;
  }

  getPropertyValues(concept, code) {
    if (!concept.property) return [];
    return concept.property
        .filter(p => p.code === code)
        .map(p => this.extractPropertyValue(p))
        .filter(v => v !== null);
  }

  extractPropertyValue(prop) {
    if (prop.valueCode !== undefined) return { type: 'code', value: prop.valueCode };
    if (prop.valueString !== undefined) return { type: 'string', value: prop.valueString };
    if (prop.valueBoolean !== undefined) return { type: 'boolean', value: prop.valueBoolean };
    if (prop.valueInteger !== undefined) return { type: 'integer', value: prop.valueInteger };
    if (prop.valueDecimal !== undefined) return { type: 'decimal', value: prop.valueDecimal };
    if (prop.valueDateTime !== undefined) return { type: 'dateTime', value: prop.valueDateTime };
    if (prop.valueCoding !== undefined) return { type: 'coding', value: prop.valueCoding };
    return null;
  }

  async renderPropertyValue(td, val, propDef, cs) {
    if (!val) return;

    switch (val.type) {
      case 'code': {
        // If it's a parent reference, link to it
        if (propDef.code === 'parent' || propDef.code === 'child') {
          td.ah('#' + cs.id + '-' + val.value).tx(val.value);
        } else {
          td.code().tx(val.value);
        }
        break;
      }
      case 'coding': {
        const coding = val.value;
        const link = this.linkResolver ?
            await this.linkResolver.resolveCode(this.opContext, coding.system, coding.version, coding.code) : null;
        if (link) {
          td.ah(link.link).tx(coding.code);
        } else {
          td.tx(coding.code);
        }
        if (coding.display) {
          td.tx(' "' + coding.display + '"');
        }
        break;
      }
      case 'boolean': {
        td.tx(val.value ? 'true' : 'false');
        break;
      }
      case 'string': {
        // Check if it's a URL
        if (val.value.startsWith('http://') || val.value.startsWith('https://')) {
          td.ah(val.value).tx(val.value);
        } else {
          td.tx(val.value);
        }
        break;
      }
      default:
        td.tx(String(val.value));
    }
  }

  sentenceForContent(mode, cs) {
    switch (mode) {
      case 'complete':
        return this.translate('CODESYSTEM_CONTENT_COMPLETE');
      case 'example':
        return this.translate('CODESYSTEM_CONTENT_EXAMPLE');
      case 'fragment':
        return this.translate('CODESYSTEM_CONTENT_FRAGMENT');
      case 'not-present':
        return this.translate('CODESYSTEM_CONTENT_NOTPRESENT');
      case 'supplement': {
        const hasProperties = cs.property && cs.property.length > 0;
        const hasDesignations = this.hasDesignations(cs);
        let features;
        if (hasProperties && hasDesignations) {
          features = this.translate('CODE_SYS_DISP_PROP');
        } else if (hasProperties) {
          features = this.translate('CODE_SYS_PROP');
        } else if (hasDesignations) {
          features = this.translate('CODE_SYS_DISP');
        } else {
          features = this.translate('CODE_SYS_FEAT');
        }
        return this.translate('CODESYSTEM_CONTENT_SUPPLEMENT', [features]);
      }
      default:
        return this.translate('CODESYSTEM_CONTENT_NOTPRESENT');
    }
  }

  hasDesignations(cs) {
    const checkConcepts = (concepts) => {
      for (const c of concepts) {
        if (c.designation && c.designation.length > 0) {
          return true;
        }
        if (c.concept && checkConcepts(c.concept)) {
          return true;
        }
      }
      return false;
    };
    return checkConcepts(cs.concept || []);
  }

  countConcepts(concepts) {
    if (!concepts) {
      return 0;
    }
    let count = concepts.length;
    for (const c of concepts) {
      if (c.concept) {
        count += this.countConcepts(c.concept);
      }
    }
    return count;
  }

}

module.exports = { Renderer };
