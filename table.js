import debounce from 'utils/debounce';
import { add, rem, addSocket } from 'event';
import split from 'split.js';
import { cfg } from 'configs';
import { emit, req } from 'socket';
import Tooltip from 'tooltip';
import downloadFile from 'utils/download';

export default class Table {
 constructor(opt) {
  Object.assign(this, opt);
  this._id = Math.random();
  this.data._id = this._id;
  if (!this.data.remote && !this.data.local) this.data.local = Math.random();
  this.visibleNodeCount_ = 0;
  this.rowH_ = 15;
  this.request_ = 0;
  this.act_ = 3; // 0 scroll, 1 = filter, 2 sort, 3 ini
  this.data.filter = {};
  this.data.rf = '';
  this.rangeFilters_ = new Set();
  this.myFilters_ = [];
  this.visibleRows_ = [];
  this.sort_ = new Map();
  this.createContainer_();
  if (this.arr) this.data.arr = this.arr;
  this.debouce_renderEmpty_ = debounce(this.renderEmpty_.bind(this), 6);
  this.debouce_populateViewport_ = debounce(this.populateViewport_.bind(this), !this.data.remote ? 6 : 40);
  this.debouce_onVportResize_ = debounce(this.onVportResize_.bind(this), 200);
  this.resizeObservers_ = new ResizeObserver(this.debouce_onVportResize_.bind(this));
  this.debouce_filterInput_ = debounce(this.filterInput_.bind(this), 400);
  addSocket('newdata', this.onUpdate_.bind(this), this.tId_);
  addSocket('updatedata', this.onUpdate_.bind(this), this.tId_);
  addSocket('deletedata', this.onUpdate_.bind(this), this.tId_);
  addSocket('config', this.newConf_.bind(this), this._id);
  add(this.vPort_, 'scroll', this.scroll_.bind(this), this._id);
  add(this.vPort_, 'click', this.click_.bind(this), this._id);
  add(this.vPort_, 'contextmenu', this.rightClick_.bind(this), this._id);
  if (this.menu) {
   const menu = new Map();
   for (const [name, fc] of Object.entries(this.menu)) {
    menu.set(name, { onClick: (e) => fc(this.visibleRows_[e.target.closest('tr').rowIndex]) });
   }
   this.tableMenu_ = new Tooltip({
    ref: this.vPort_,
    trigger: 'manual',
    placement: 'right-start',
    offset: [0, 0],
    appendTo: document.body,
    menu,
    hideOnEsc: true,
   });
  }
  this.el.appendChild(this.vContainer_);
  this.createHeader_();
  this.resizeObservers_.observe(this.vPort_);
 }

 onUpdate_(data) {
  if (data.name === this.data.remote || data.name === this.data.local) {
   this.act_ = 4;
   if (data.type === 'deletedata' && this.startIndex_ > 0) this.startIndex_ -= 1;
   this.populateViewport_(this.startIndex_);
  }
 }

 onVportResize_(entries) {
  for (const entry of entries) {
   this.tableH_ = entry.borderBoxSize[0].blockSize;
   const rowsPerPage = Math.ceil(this.tableH_ / this.rowH_);
   if (this.visibleNodeCount_ === rowsPerPage) return;
   this.visibleNodeCount_ = rowsPerPage;
   this.lastPageH_ = Math.max(Math.floor(this.scrollH_ - this.tableH_), 0);
   const limit = rowsPerPage - this.vTable_.rows.length;
   if (limit > 0) {
    if (typeof this.startIndex_ === 'undefined') this.populateViewport_(0);
    else {
     req('table_rows', { data: this.data, skip: this.startIndex_ + rowsPerPage - limit, limit }, { rid: (this.request_ += 1) }).then((res) => {
      const { rows, rid } = res;
      if (rid !== this.request_) return;
      this.visibleRows_.push(...rows);
      this.renderFill_();
     });
    }
   } else {
    for (let i = 0; i < -limit; i += 1) {
     this.visibleRows_.pop();
     this.vTable_.deleteRow(-1);
    }
   }
  }
 }

 scroll_() {
  const pos = this.vPort_.scrollTop;
  const startIndex = Math.floor(Math.min(this.lastPageH_, pos) / 15);
  if (this.startPos_ === startIndex) return;
  this.startPos_ = startIndex;
  if (this.data.remote) {
   let top = false;
   let limit;
   if (startIndex < this.startIndex_) {
    limit = this.startIndex_ - startIndex;
    top = true;
   } else if (startIndex > this.startIndex_) limit = startIndex - this.startIndex_;
   this.debouce_renderEmpty_([limit, top, startIndex]);
  }
  this.debouce_populateViewport_(startIndex);
 }

 populateViewport_(scrollIndex) {
  const startIndex = scrollIndex;
  if (startIndex === this.startIndex_ && this.lastReq_ === this.request_) return;
  this.removeSelectedRow_();
  let currentStartIndex = scrollIndex;
  this.lastReq_ = this.request_;
  let top = false;
  let limit = 0;
  if (startIndex < this.startIndex_) {
   limit = this.startIndex_ - startIndex;
   top = true;
  } else if (startIndex > this.startIndex_) {
   limit = startIndex - this.startIndex_;
   if (limit < this.visibleNodeCount_) currentStartIndex += this.visibleNodeCount_ - limit;
  }
  if (limit > this.visibleNodeCount_ || !limit) limit = this.visibleNodeCount_;
  req('table_rows', { data: this.data, skip: currentStartIndex, limit, act: this.act_ }, { rid: (this.request_ += 1) }).then((res) => {
   const { tr, rows, rid } = res;
   if (rid !== this.request_) return;
   const rowsLen = rows.length;
   this.data.rf = '';
   if (this.act_ === 3) {
    delete this.arr;
    delete this.data.arr;
   }
   this.act_ = 0;
   if (tr !== undefined) {
    this.totalRows_ = tr;
    this.scrollH_ = this.totalRows_ * 15;
    this.lastPageH_ = Math.max(Math.floor(this.scrollH_ - this.tableH_), 0);
    this.vH_.style.height = this.scrollH_ + 'px';
    const diff = this.visibleRows_.length - rowsLen;
    if (diff > 0) {
     this.visibleRows_.splice(-diff);
     for (let i = 0; i < diff; i += 1) this.vTable_.deleteRow(-1);
    } else this.visibleRows_ = rows;
   }
   this.startIndex_ = startIndex;
   if (rowsLen === this.visibleNodeCount_) this.visibleRows_ = rows;
   else if (!rowsLen) {
    for (let i = 0; i < this.visibleNodeCount_; i += 1) this.vTable_.deleteRow(-1);
   } else if (top) {
    this.visibleRows_.unshift(...rows);
    this.visibleRows_.splice(-rowsLen);
   } else {
    this.visibleRows_.push(...rows);
    this.visibleRows_.splice(0, rowsLen);
   }
   this.renderFill_(startIndex);
  });
 }

 renderEmpty_([limit, top, startIndex]) {
  if (!limit) return;
  for (let i = 0; i < this.visibleNodeCount_; i += 1) {
   let rowEl = this.vTable_.rows[i];
   if (!rowEl) rowEl = this.addEmptyRow_();
   let cell = rowEl.firstElementChild;
   if (!this.noIndex) {
    cell.textContent = startIndex + i + 1;
    cell = cell.nextElementSibling;
   }

   if ((i > limit && top) || (i < this.visibleNodeCount_ - limit && !top)) {
    let row = this.visibleRows_[i + limit];
    if (i > limit && top) row = this.visibleRows_[i - limit];
    this.cols.forEach((col) => {
     if (!('rowhtml' in col)) cell.textContent = row[col.field];
     else cell.innerHTML = col.rowhtml(cell, col, row);
     cell = cell.nextElementSibling;
    });
   } else {
    this.cols.forEach(() => {
     cell.textContent = '...';
     cell = cell.nextElementSibling;
    });
   }
  }
 }

 renderFill_(currentStartIndex = this.startIndex_) {
  let rowEl = this.vTable_.rows[0];
  const startIndex = currentStartIndex + 1;
  this.visibleRows_.forEach((row, i) => {
   if (!row) return;
   if (!rowEl) rowEl = this.addEmptyRow_();
   let cell = rowEl.firstElementChild;
   if (!this.noIndex) {
    cell.textContent = startIndex + i;
    cell = cell.nextElementSibling;
   }
   this.cols.forEach((col) => {
    if (!('rowhtml' in col)) cell.textContent = row[col.field];
    else cell.innerHTML = col.rowhtml(cell, col, row);
    cell = cell.nextElementSibling;
   });
   rowEl = rowEl.nextElementSibling;
  });
 }

 addEmptyRow_() {
  const rowEl = document.createElement('tr');
  if (!this.noIndex) rowEl.appendChild(document.createElement('td'));
  this.cols.forEach((col, x) => {
   const td = document.createElement('td');
   if (this.vTable_.rows.length === 0 && (!this.noIndex || rowEl.childElementCount > 1)) td.style.width = (this.colSizes_?.[x] ?? col.size) + '%';
   rowEl.appendChild(td);
  });
  this.vTable_.appendChild(rowEl);
  return rowEl;
 }

 createContainer_() {
  this.vContainer_ = document.createElement('div');
  this.vContainer_.className = 'vt';
  if (this.style) Object.assign(this.vContainer_.style, this.style);
  this.vCaption_ = document.createElement('div');
  if (this.caption) {
   if (typeof this.caption === 'string') this.vCaption_.innerHTML = this.caption;
   else this.vCaption_.appendChild(this.caption);
  }
  this.vHead_ = document.createElement('div');
  this.vHead_.className = 'vhead';
  this.vPort_ = document.createElement('div');
  this.vPort_.className = 'vport';
  this.vTable_ = document.createElement('table');
  this.vH_ = document.createElement('div');
  this.vH_.className = 'vh';
  this.vTable_.className = 'vtable';
  if (this.addClass) this.vTable_.classList.add(this.addClass);
  if (!this.noIndex) this.vTable_.classList.add('idx');
  this.vPort_.append(this.vTable_, this.vH_);
  this.vfoot_ = document.createElement('div');
  this.vfoot_.className = 'vfoot';
  if (this.foot) {
   if (typeof this.foot === 'string') this.vfoot_.innerHTML = this.caption;
   else this.vfoot_.appendChild(this.foot);
  }
  this.vContainer_.append(this.vCaption_, this.vHead_, this.vPort_, this.vfoot_);
 }

 createHeader_() {
  const splits = [];
  const sizes = [];
  if (!this.noIndex) {
   const id = document.createElement('div');
   id.className = 'cid';
   this.vHead_.appendChild(id);
  }
  for (const col of this.cols) {
   const c = document.createElement('div');
   c.className = 'col';
   if (typeof col.name !== 'function') {
    const txt = document.createElement('span');
    if (col.name) txt.appendChild(document.createTextNode(col.name));
    c.appendChild(txt);
   } else col.name?.(c, col);
   add(c, 'click', this.sortCol_.bind(this, col, c), this._id);
   if (col.s) {
    let defaultOp = 'contains';
    const wrap = document.createElement('label');
    wrap.className = 'filter';
    const operator = document.createElement('div');
    const input = document.createElement('input');
    if (col.s.type === 'int' || col.s.type === 'date') defaultOp = 'eq';
    operator.className = 'op ' + defaultOp;
    col.s.op = defaultOp;
    const menu = new Map();
    if (col.s.type === 'text') {
     input.placeholder = 'Filtru';
     menu.set('Contine', { class: 'contains', onClick: this.filterChange_.bind(this, col, 'contains', input, operator) });
     menu.set('Nu Contine', { class: 'ne', onClick: this.filterChange_.bind(this, col, 'ne', input, operator) });
     menu.set('Exact', { class: 'eq', onClick: this.filterChange_.bind(this, col, 'eq', input, operator) });
     menu.set('Exclus', { class: 'neq', onClick: this.filterChange_.bind(this, col, 'ne', input, operator) });
     menu.set('Incepe Cu', { class: 'starts', onClick: this.filterChange_.bind(this, col, 'starts', input, operator) });
     menu.set('Inceput Cuvant', { class: 'any', onClick: this.filterChange_.bind(this, col, 'any', input, operator) });
    } else if (col.s.type === 'int') {
     input.type = 'number';
     menu.set('Exact', { class: 'eq', onClick: this.filterChange_.bind(this, col, 'eq', input, operator) });
     menu.set('Exclus', { class: 'neq', onClick: this.filterChange_.bind(this, col, 'ne', input, operator) });
     menu.set('Mai Mare sau Egal', { class: 'gte', onClick: this.filterChange_.bind(this, col, 'gte', input, operator) });
     menu.set('Mai Mic sau Egal', { class: 'lte', onClick: this.filterChange_.bind(this, col, 'lte', input, operator) });
     menu.set('Interval', { class: 'between', onClick: this.filterChange_.bind(this, col, 'between', input, operator) });
    } else if (col.s.type === 'date') {
     input.type = 'date';
     menu.set('Astazi', { class: 'eq', onClick: this.dateFilterChange_.bind(this, col, 'eq', new Date(), input, operator) });
     menu.set('De la', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', '', input, operator) });
     menu.set('Pana la', { class: 'lte', onClick: this.dateFilterChange_.bind(this, col, 'lte', '', input, operator) });
     menu.set('Interval', { class: 'between', onClick: this.dateFilterChange_.bind(this, col, 'between', '', input, operator) });
     menu.set('Saptamana asta', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().setDate(new Date().getDate() - new Date().getDay() + 1)), input, operator) });
     menu.set('Luna asta', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().getFullYear(), new Date().getMonth(), 1), input, operator) });
     menu.set('Anul asta', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().getFullYear(), 0, 1), input, operator) });
     menu.set('Ultima saptamana', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().setDate(new Date().getDate() - 7)), input, operator) });
     menu.set('Ultima luna', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().setMonth(new Date().getMonth() - 1)), input, operator) });
     menu.set('Ultimul an', { class: 'gte', onClick: this.dateFilterChange_.bind(this, col, 'gte', new Date(new Date().setFullYear(new Date().getFullYear() - 1)), input, operator) });
     menu.set('Anuleaza', { class: 'eq', onClick: this.dateFilterChange_.bind(this, col, 'eq', '', input, operator) });
    }
    const tooltip = new Tooltip({
     ref: operator,
     placement: 'bottom-start',
     offset: [0, 2],
     menu,
     hideOnEsc: true,
     onHidden: () => input.focus(),
    });
    this.myFilters_.push(tooltip);
    wrap.appendChild(input);
    wrap.appendChild(operator);
    add(input, 'input', this.debouce_filterInput_.bind(this, [col.s, input, 0]), this._id);
    c.appendChild(wrap);
   }
   this.vHead_.appendChild(c);
   splits.push(c);
   sizes.push(col.size);
  }
  this.colSizes_ = cfg.config?.[this.tName] || sizes;
  const options = document.createElement('div');
  options.className = 'opt';
  this.vHead_.appendChild(options);
  this.tableOptions_ = new Tooltip({
   ref: options,
   placement: 'bottom',
   offset: [0, 0],
   menu: new Map([['Genereaza CSV', { onClick: this.toCSV.bind(this) }]]),
   hideOnEsc: true,
   zIndex: 10,
  });
  this.splitCol_ = split(splits, { snapOffset: 0, sizes: cfg.config?.[this.tName] || sizes, minSize: 40, gutterSize: 3, onDragEnd: this.resizeCols_.bind(this) });
 }

 dateFilterChange_(col, op, time, input, operator) {
  if (time) input.value = [time.getFullYear(), ('0' + (time.getMonth() + 1)).slice(-2), ('0' + time.getDate()).slice(-2)].join('-');
  else input.value = '';
  this.filterChange_(col, op, input, operator);
 }

 filterChange_(col, op, input, operator) {
  if (op === 'between' && col.s.op !== 'between') {
   const to = document.createElement('input');
   to.type = col.s.type === 'date' ? 'date' : 'number';
   input.parentElement.prepend(to);
   // console.log(col);
   add(to, 'input', this.debouce_filterInput_.bind(this, [col.s, input, 0]), this._id + col.field);
   this.rangeFilters_.add(this._id + col.field);
  } else if (col.s.op === 'between') {
   this.rangeFilters_.delete(this._id + col.field);
   input.parentElement.firstElementChild.remove();
   rem(this._id + col.field);
  }
  operator.classList.replace(col.s.op, op);
  Object.assign(col.s, { op });
  this.filterInput_([col.s, input, 1]);
 }

 filterInput_([colS, e, change]) {
  let v;
  if (colS.op === 'between') {
   if (e.value && e.previousElementSibling.value) v = [e.value, e.previousElementSibling.value];
  } else v = colS.type === 'text' ? e.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : e.value;
  if ((colS.v && colS.v !== v) || v || (v && change)) {
   colS.v = v;
   if (!v) {
    delete this.data.filter[colS.field];
    this.data.rf = colS.field;
   } else this.data.filter[colS.field] = { op: colS.op, type: colS.type, v: colS.v };
   this.act_ = 1;
   if (this.startIndex_) this.vPort_.scrollTop = 0;
   else this.populateViewport_(0);
  }
 }

 resizeCols_(val, save = true) {
  this.colSizes_ = [...val];
  let i = 0;
  if (!this.totalRows_) return;
  for (const cell of this.vTable_.rows[0].cells) {
   if (this.noIndex || cell.cellIndex !== 0) {
    cell.style.width = val[i] + '%';
    i += 1;
   }
  }
  if (save) emit('config', { [this.tName]: val });
 }

 sortCol_(col, el, e) {
  if (e.target.classList.contains('col') || e.target.tagName === 'SPAN') {
   const sort = [];
   const val = this.sort_.get(col.field);
   if (val === false) {
    this.sort_.delete(col.field);
    el.classList.remove('desc');
   } else {
    if (typeof val === 'undefined') el.classList.add('asc');
    else el.classList.replace('asc', 'desc');
    this.sort_.set(col.field, !val);
   }
   for (const [key, value] of this.sort_) sort.push([key, !value]);
   this.sort_[col.field] = !this.sort_[col.field];
   this.data.sortCol = sort;
   if (!sort.length) delete this.data.sortCol;
   this.act_ = 2;
   if (this.startIndex_) this.vPort_.scrollTop = 0;
   else this.populateViewport_(0);
  }
 }

 newConf_(o) {
  if (o.db[this.tName]) {
   this.splitCol_.setSizes(o.db[this.tName]);
   this.resizeCols_(o.db[this.tName], false);
  }
 }

 async toCSV() {
  const csv = [];
  const cols = this.cols.map((col) => col.name);
  csv.push(cols.join(','));
  const res = await req('table_rows', { data: this.data, skip: 0, limit: 0 });
  res.rows.forEach((row) => csv.push(this.cols.map((col) => JSON.stringify(col.rowhtml?.(null, col, row) || row[col.field])).join(',')));
  downloadFile(new Blob([csv.join('\n')], { type: 'text/plain' }), this.tName);
 }

 get vCaption() {
  return this.vCaption_;
 }

 click_(e) {
  const tr = e.target.closest('tr');
  if (!tr) return;
  this.selectRow_(tr);
  this.rowOnClick?.(this.visibleRows_[e.target.closest('tr').rowIndex], e);
 }

 rightClick_(e) {
  const tr = e.target.closest('tr');
  if (!tr) return;
  this.selectRow_(tr);
 }

 selectRow_(e) {
  this.removeSelectedRow_();
  this.selectedrow = e;
  this.selectedrow.classList.add('selected');
 }

 removeSelectedRow_() {
  if (this.selectedrow) this.selectedrow.removeAttribute('class');
  this.selectedrow = null;
 }

 destroy() {
  rem(this._id);
  if (!this.data.remote) emit('table_destroy', { data: this.data });
  this.resizeObservers_.disconnect();
  this.resizeObservers_ = '';
  this.tableOptions_?.destroy();
  this.tableOptions_ = null;
  this.myFilters_.forEach((f) => f.destroy());
  this.myFilters_ = null;
  this.splitCol_.destroy();
  this.splitCol_ = null;
  this.rangeFilters_?.forEach(rem);
  this.rangeFilters_ = null;
  this.el.removeChild(this.vContainer_);
 }
}
