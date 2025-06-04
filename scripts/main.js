"use strict";
(function() {

var $goVersion = "go1.19.13";
Error.stackTraceLimit = Infinity;

var $NaN = NaN;
var $global, $module;
if (typeof window !== "undefined") { /* web page */
    $global = window;
} else if (typeof self !== "undefined") { /* web worker */
    $global = self;
} else if (typeof global !== "undefined") { /* Node.js */
    $global = global;
    $global.require = require;
} else { /* others (e.g. Nashorn) */
    $global = this;
}

if ($global === undefined || $global.Array === undefined) {
    throw new Error("no global object found");
}
if (typeof module !== "undefined") {
    $module = module;
}

if (!$global.fs && $global.require) {
    try {
        var fs = $global.require('fs');
        if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
            $global.fs = fs;
        }
    } catch (e) { /* Ignore if the module couldn't be loaded. */ }
}

if (!$global.fs) {
    var outputBuf = "";
    var decoder = new TextDecoder("utf-8");
    $global.fs = {
        constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
        writeSync: function writeSync(fd, buf) {
            outputBuf += decoder.decode(buf);
            var nl = outputBuf.lastIndexOf("\n");
            if (nl != -1) {
                console.log(outputBuf.substr(0, nl));
                outputBuf = outputBuf.substr(nl + 1);
            }
            return buf.length;
        },
        write: function write(fd, buf, offset, length, position, callback) {
            if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
            }
            var n = this.writeSync(fd, buf);
            callback(null, n);
        }
    };
}

var $linknames = {} // Collection of functions referenced by a go:linkname directive.
var $packages = {}, $idCounter = 0;
var $keys = m => { return m ? Object.keys(m) : []; };
var $flushConsole = () => { };
var $throwRuntimeError; /* set by package "runtime" */
var $throwNilPointerError = () => { $throwRuntimeError("invalid memory address or nil pointer dereference"); };
var $call = (fn, rcvr, args) => { return fn.apply(rcvr, args); };
var $makeFunc = fn => { return function(...args) { return $externalize(fn(this, new ($sliceType($jsObjectPtr))($global.Array.prototype.slice.call(args, []))), $emptyInterface); }; };
var $unused = v => { };
var $print = console.log;
// Under Node we can emulate print() more closely by avoiding a newline.
if (($global.process !== undefined) && $global.require) {
    try {
        var util = $global.require('util');
        $print = function(...args) { $global.process.stderr.write(util.format.apply(this, args)); };
    } catch (e) {
        // Failed to require util module, keep using console.log().
    }
}
var $println = console.log

var $initAllLinknames = () => {
    var names = $keys($packages);
    for (var i = 0; i < names.length; i++) {
        var f = $packages[names[i]]["$initLinknames"];
        if (typeof f == 'function') {
            f();
        }
    }
}

var $mapArray = (array, f) => {
    var newArray = new array.constructor(array.length);
    for (var i = 0; i < array.length; i++) {
        newArray[i] = f(array[i]);
    }
    return newArray;
};

// $mapIndex returns the value of the given key in m, or undefined if m is nil/undefined or not a map
var $mapIndex = (m, key) => {
    return typeof m.get === "function" ? m.get(key) : undefined;
};
// $mapDelete deletes the key and associated value from m.  If m is nil/undefined or not a map, $mapDelete is a no-op
var $mapDelete = (m, key) => {
    typeof m.delete === "function" && m.delete(key)
};
// Returns a method bound to the receiver instance, safe to invoke as a 
// standalone function. Bound function is cached for later reuse.
var $methodVal = (recv, name) => {
    var vals = recv.$methodVals || {};
    recv.$methodVals = vals; /* noop for primitives */
    var f = vals[name];
    if (f !== undefined) {
        return f;
    }
    var method = recv[name];
    f = method.bind(recv);
    vals[name] = f;
    return f;
};

var $methodExpr = (typ, name) => {
    var method = typ.prototype[name];
    if (method.$expr === undefined) {
        method.$expr = (...args) => {
            $stackDepthOffset--;
            try {
                if (typ.wrapped) {
                    args[0] = new typ(args[0]);
                }
                return Function.call.apply(method, args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return method.$expr;
};

var $ifaceMethodExprs = {};
var $ifaceMethodExpr = name => {
    var expr = $ifaceMethodExprs["$" + name];
    if (expr === undefined) {
        expr = $ifaceMethodExprs["$" + name] = (...args) => {
            $stackDepthOffset--;
            try {
                return Function.call.apply(args[0][name], args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return expr;
};

var $subslice = (slice, low, high, max) => {
    if (high === undefined) {
        high = slice.$length;
    }
    if (max === undefined) {
        max = slice.$capacity;
    }
    if (low < 0 || high < low || max < high || high > slice.$capacity || max > slice.$capacity) {
        $throwRuntimeError("slice bounds out of range");
    }
    if (slice === slice.constructor.nil) {
        return slice;
    }
    var s = new slice.constructor(slice.$array);
    s.$offset = slice.$offset + low;
    s.$length = high - low;
    s.$capacity = max - low;
    return s;
};

var $substring = (str, low, high) => {
    if (low < 0 || high < low || high > str.length) {
        $throwRuntimeError("slice bounds out of range");
    }
    return str.substring(low, high);
};

// Convert Go slice to an equivalent JS array type.
var $sliceToNativeArray = slice => {
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
    }
    return slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
};

// Convert Go slice to a pointer to an underlying Go array.
// 
// Note that an array pointer can be represented by an "unwrapped" native array
// type, and it will be wrapped back into its Go type when necessary.
var $sliceToGoArray = (slice, arrayPtrType) => {
    var arrayType = arrayPtrType.elem;
    if (arrayType !== undefined && slice.$length < arrayType.len) {
        $throwRuntimeError("cannot convert slice with length " + slice.$length + " to pointer to array with length " + arrayType.len);
    }
    if (slice == slice.constructor.nil) {
        return arrayPtrType.nil; // Nil slice converts to nil array pointer.
    }
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + arrayType.len);
    }
    if (slice.$offset == 0 && slice.$length == slice.$capacity && slice.$length == arrayType.len) {
        return slice.$array;
    }
    if (arrayType.len == 0) {
        return new arrayType([]);
    }

    // Array.slice (unlike TypedArray.subarray) returns a copy of an array range,
    // which is not sharing memory with the original one, which violates the spec
    // for slice to array conversion. This is incompatible with the Go spec, in
    // particular that the assignments to the array elements would be visible in
    // the slice. Prefer to fail explicitly instead of creating subtle bugs.
    $throwRuntimeError("gopherjs: non-numeric slice to underlying array conversion is not supported for subslices");
};

// Convert between compatible slice types (e.g. native and names).
var $convertSliceType = (slice, desiredType) => {
    if (slice == slice.constructor.nil) {
        return desiredType.nil; // Preserve nil value.
    }

    return $subslice(new desiredType(slice.$array), slice.$offset, slice.$offset + slice.$length);
}

var $decodeRune = (str, pos) => {
    var c0 = str.charCodeAt(pos);

    if (c0 < 0x80) {
        return [c0, 1];
    }

    if (c0 !== c0 || c0 < 0xC0) {
        return [0xFFFD, 1];
    }

    var c1 = str.charCodeAt(pos + 1);
    if (c1 !== c1 || c1 < 0x80 || 0xC0 <= c1) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xE0) {
        var r = (c0 & 0x1F) << 6 | (c1 & 0x3F);
        if (r <= 0x7F) {
            return [0xFFFD, 1];
        }
        return [r, 2];
    }

    var c2 = str.charCodeAt(pos + 2);
    if (c2 !== c2 || c2 < 0x80 || 0xC0 <= c2) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF0) {
        var r = (c0 & 0x0F) << 12 | (c1 & 0x3F) << 6 | (c2 & 0x3F);
        if (r <= 0x7FF) {
            return [0xFFFD, 1];
        }
        if (0xD800 <= r && r <= 0xDFFF) {
            return [0xFFFD, 1];
        }
        return [r, 3];
    }

    var c3 = str.charCodeAt(pos + 3);
    if (c3 !== c3 || c3 < 0x80 || 0xC0 <= c3) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF8) {
        var r = (c0 & 0x07) << 18 | (c1 & 0x3F) << 12 | (c2 & 0x3F) << 6 | (c3 & 0x3F);
        if (r <= 0xFFFF || 0x10FFFF < r) {
            return [0xFFFD, 1];
        }
        return [r, 4];
    }

    return [0xFFFD, 1];
};

var $encodeRune = r => {
    if (r < 0 || r > 0x10FFFF || (0xD800 <= r && r <= 0xDFFF)) {
        r = 0xFFFD;
    }
    if (r <= 0x7F) {
        return String.fromCharCode(r);
    }
    if (r <= 0x7FF) {
        return String.fromCharCode(0xC0 | r >> 6, 0x80 | (r & 0x3F));
    }
    if (r <= 0xFFFF) {
        return String.fromCharCode(0xE0 | r >> 12, 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
    }
    return String.fromCharCode(0xF0 | r >> 18, 0x80 | (r >> 12 & 0x3F), 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
};

var $stringToBytes = str => {
    var array = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
        array[i] = str.charCodeAt(i);
    }
    return array;
};

var $bytesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i += 10000) {
        str += String.fromCharCode.apply(undefined, slice.$array.subarray(slice.$offset + i, slice.$offset + Math.min(slice.$length, i + 10000)));
    }
    return str;
};

var $stringToRunes = str => {
    var array = new Int32Array(str.length);
    var rune, j = 0;
    for (var i = 0; i < str.length; i += rune[1], j++) {
        rune = $decodeRune(str, i);
        array[j] = rune[0];
    }
    return array.subarray(0, j);
};

var $runesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i++) {
        str += $encodeRune(slice.$array[slice.$offset + i]);
    }
    return str;
};

var $copyString = (dst, src) => {
    var n = Math.min(src.length, dst.$length);
    for (var i = 0; i < n; i++) {
        dst.$array[dst.$offset + i] = src.charCodeAt(i);
    }
    return n;
};

var $copySlice = (dst, src) => {
    var n = Math.min(src.$length, dst.$length);
    $copyArray(dst.$array, src.$array, dst.$offset, src.$offset, n, dst.constructor.elem);
    return n;
};

var $copyArray = (dst, src, dstOffset, srcOffset, n, elem) => {
    if (n === 0 || (dst === src && dstOffset === srcOffset)) {
        return;
    }

    if (src.subarray) {
        dst.set(src.subarray(srcOffset, srcOffset + n), dstOffset);
        return;
    }

    switch (elem.kind) {
        case $kindArray:
        case $kindStruct:
            if (dst === src && dstOffset > srcOffset) {
                for (var i = n - 1; i >= 0; i--) {
                    elem.copy(dst[dstOffset + i], src[srcOffset + i]);
                }
                return;
            }
            for (var i = 0; i < n; i++) {
                elem.copy(dst[dstOffset + i], src[srcOffset + i]);
            }
            return;
    }

    if (dst === src && dstOffset > srcOffset) {
        for (var i = n - 1; i >= 0; i--) {
            dst[dstOffset + i] = src[srcOffset + i];
        }
        return;
    }
    for (var i = 0; i < n; i++) {
        dst[dstOffset + i] = src[srcOffset + i];
    }
};

var $clone = (src, type) => {
    var clone = type.zero();
    type.copy(clone, src);
    return clone;
};

var $pointerOfStructConversion = (obj, type) => {
    if (obj.$proxies === undefined) {
        obj.$proxies = {};
        obj.$proxies[obj.constructor.string] = obj;
    }
    var proxy = obj.$proxies[type.string];
    if (proxy === undefined) {
        var properties = {};
        for (var i = 0; i < type.elem.fields.length; i++) {
            (fieldProp => {
                properties[fieldProp] = {
                    get() { return obj[fieldProp]; },
                    set(value) { obj[fieldProp] = value; }
                };
            })(type.elem.fields[i].prop);
        }
        proxy = Object.create(type.prototype, properties);
        proxy.$val = proxy;
        obj.$proxies[type.string] = proxy;
        proxy.$proxies = obj.$proxies;
    }
    return proxy;
};

var $append = function (slice) {
    return $internalAppend(slice, arguments, 1, arguments.length - 1);
};

var $appendSlice = (slice, toAppend) => {
    if (toAppend.constructor === String) {
        var bytes = $stringToBytes(toAppend);
        return $internalAppend(slice, bytes, 0, bytes.length);
    }
    return $internalAppend(slice, toAppend.$array, toAppend.$offset, toAppend.$length);
};

var $internalAppend = (slice, array, offset, length) => {
    if (length === 0) {
        return slice;
    }

    var newArray = slice.$array;
    var newOffset = slice.$offset;
    var newLength = slice.$length + length;
    var newCapacity = slice.$capacity;

    if (newLength > newCapacity) {
        newOffset = 0;
        newCapacity = Math.max(newLength, slice.$capacity < 1024 ? slice.$capacity * 2 : Math.floor(slice.$capacity * 5 / 4));

        if (slice.$array.constructor === Array) {
            newArray = slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
            newArray.length = newCapacity;
            var zero = slice.constructor.elem.zero;
            for (var i = slice.$length; i < newCapacity; i++) {
                newArray[i] = zero();
            }
        } else {
            newArray = new slice.$array.constructor(newCapacity);
            newArray.set(slice.$array.subarray(slice.$offset, slice.$offset + slice.$length));
        }
    }

    $copyArray(newArray, array, newOffset + slice.$length, offset, length, slice.constructor.elem);

    var newSlice = new slice.constructor(newArray);
    newSlice.$offset = newOffset;
    newSlice.$length = newLength;
    newSlice.$capacity = newCapacity;
    return newSlice;
};

var $equal = (a, b, type) => {
    if (type === $jsObjectPtr) {
        return a === b;
    }
    switch (type.kind) {
        case $kindComplex64:
        case $kindComplex128:
            return a.$real === b.$real && a.$imag === b.$imag;
        case $kindInt64:
        case $kindUint64:
            return a.$high === b.$high && a.$low === b.$low;
        case $kindArray:
            if (a.length !== b.length) {
                return false;
            }
            for (var i = 0; i < a.length; i++) {
                if (!$equal(a[i], b[i], type.elem)) {
                    return false;
                }
            }
            return true;
        case $kindStruct:
            for (var i = 0; i < type.fields.length; i++) {
                var f = type.fields[i];
                if (!$equal(a[f.prop], b[f.prop], f.typ)) {
                    return false;
                }
            }
            return true;
        case $kindInterface:
            return $interfaceIsEqual(a, b);
        default:
            return a === b;
    }
};

var $interfaceIsEqual = (a, b) => {
    if (a === $ifaceNil || b === $ifaceNil) {
        return a === b;
    }
    if (a.constructor !== b.constructor) {
        return false;
    }
    if (a.constructor === $jsObjectPtr) {
        return a.object === b.object;
    }
    if (!a.constructor.comparable) {
        $throwRuntimeError("comparing uncomparable type " + a.constructor.string);
    }
    return $equal(a.$val, b.$val, a.constructor);
};

var $unsafeMethodToFunction = (typ, name, isPtr) => {
    if (isPtr) {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $pointerOfStructConversion(r, ptrType);
                        break;
                    case $kindArray:
                        r = new ptrType(r);
                        break;
                    default:
                        r = new ptrType(r.$get, r.$set, r.$target);
                }
            }
            return r[name](...args);
        };
    } else {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $clone(r, typ);
                        break;
                    case $kindSlice:
                        r = $convertSliceType(r, typ);
                        break;
                    case $kindComplex64:
                    case $kindComplex128:
                        r = new typ(r.$real, r.$imag);
                        break;
                    default:
                        r = new typ(r);
                }
            }
            return r[name](...args);
        };
    }
};

var $id = x => {
    return x;
};

var $instanceOf = (x, y) => {
    return x instanceof y;
};

var $typeOf = x => {
    return typeof (x);
};
var $min = Math.min;
var $mod = (x, y) => { return x % y; };
var $parseInt = parseInt;
var $parseFloat = f => {
    if (f !== undefined && f !== null && f.constructor === Number) {
        return f;
    }
    return parseFloat(f);
};

var $froundBuf = new Float32Array(1);
var $fround = Math.fround || (f => {
    $froundBuf[0] = f;
    return $froundBuf[0];
});

var $imul = Math.imul || ((a, b) => {
    var ah = (a >>> 16) & 0xffff;
    var al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff;
    var bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) >> 0);
});

var $floatKey = f => {
    if (f !== f) {
        $idCounter++;
        return "NaN$" + $idCounter;
    }
    return String(f);
};

var $flatten64 = x => {
    return x.$high * 4294967296 + x.$low;
};

var $shiftLeft64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high << y | x.$low >>> (32 - y), (x.$low << y) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$low << (y - 32), 0);
    }
    return new x.constructor(0, 0);
};

var $shiftRightInt64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$high >> 31, (x.$high >> (y - 32)) >>> 0);
    }
    if (x.$high < 0) {
        return new x.constructor(-1, 4294967295);
    }
    return new x.constructor(0, 0);
};

var $shiftRightUint64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >>> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(0, x.$high >>> (y - 32));
    }
    return new x.constructor(0, 0);
};

var $mul64 = (x, y) => {
    var x48 = x.$high >>> 16;
    var x32 = x.$high & 0xFFFF;
    var x16 = x.$low >>> 16;
    var x00 = x.$low & 0xFFFF;

    var y48 = y.$high >>> 16;
    var y32 = y.$high & 0xFFFF;
    var y16 = y.$low >>> 16;
    var y00 = y.$low & 0xFFFF;

    var z48 = 0, z32 = 0, z16 = 0, z00 = 0;
    z00 += x00 * y00;
    z16 += z00 >>> 16;
    z00 &= 0xFFFF;
    z16 += x16 * y00;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z16 += x00 * y16;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z32 += x32 * y00;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x16 * y16;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x00 * y32;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z48 += x48 * y00 + x32 * y16 + x16 * y32 + x00 * y48;
    z48 &= 0xFFFF;

    var hi = ((z48 << 16) | z32) >>> 0;
    var lo = ((z16 << 16) | z00) >>> 0;

    var r = new x.constructor(hi, lo);
    return r;
};

var $div64 = (x, y, returnRemainder) => {
    if (y.$high === 0 && y.$low === 0) {
        $throwRuntimeError("integer divide by zero");
    }

    var s = 1;
    var rs = 1;

    var xHigh = x.$high;
    var xLow = x.$low;
    if (xHigh < 0) {
        s = -1;
        rs = -1;
        xHigh = -xHigh;
        if (xLow !== 0) {
            xHigh--;
            xLow = 4294967296 - xLow;
        }
    }

    var yHigh = y.$high;
    var yLow = y.$low;
    if (y.$high < 0) {
        s *= -1;
        yHigh = -yHigh;
        if (yLow !== 0) {
            yHigh--;
            yLow = 4294967296 - yLow;
        }
    }

    var high = 0, low = 0, n = 0;
    while (yHigh < 2147483648 && ((xHigh > yHigh) || (xHigh === yHigh && xLow > yLow))) {
        yHigh = (yHigh << 1 | yLow >>> 31) >>> 0;
        yLow = (yLow << 1) >>> 0;
        n++;
    }
    for (var i = 0; i <= n; i++) {
        high = high << 1 | low >>> 31;
        low = (low << 1) >>> 0;
        if ((xHigh > yHigh) || (xHigh === yHigh && xLow >= yLow)) {
            xHigh = xHigh - yHigh;
            xLow = xLow - yLow;
            if (xLow < 0) {
                xHigh--;
                xLow += 4294967296;
            }
            low++;
            if (low === 4294967296) {
                high++;
                low = 0;
            }
        }
        yLow = (yLow >>> 1 | yHigh << (32 - 1)) >>> 0;
        yHigh = yHigh >>> 1;
    }

    if (returnRemainder) {
        return new x.constructor(xHigh * rs, xLow * rs);
    }
    return new x.constructor(high * s, low * s);
};

var $divComplex = (n, d) => {
    var ninf = n.$real === Infinity || n.$real === -Infinity || n.$imag === Infinity || n.$imag === -Infinity;
    var dinf = d.$real === Infinity || d.$real === -Infinity || d.$imag === Infinity || d.$imag === -Infinity;
    var nnan = !ninf && (n.$real !== n.$real || n.$imag !== n.$imag);
    var dnan = !dinf && (d.$real !== d.$real || d.$imag !== d.$imag);
    if (nnan || dnan) {
        return new n.constructor(NaN, NaN);
    }
    if (ninf && !dinf) {
        return new n.constructor(Infinity, Infinity);
    }
    if (!ninf && dinf) {
        return new n.constructor(0, 0);
    }
    if (d.$real === 0 && d.$imag === 0) {
        if (n.$real === 0 && n.$imag === 0) {
            return new n.constructor(NaN, NaN);
        }
        return new n.constructor(Infinity, Infinity);
    }
    var a = Math.abs(d.$real);
    var b = Math.abs(d.$imag);
    if (a <= b) {
        var ratio = d.$real / d.$imag;
        var denom = d.$real * ratio + d.$imag;
        return new n.constructor((n.$real * ratio + n.$imag) / denom, (n.$imag * ratio - n.$real) / denom);
    }
    var ratio = d.$imag / d.$real;
    var denom = d.$imag * ratio + d.$real;
    return new n.constructor((n.$imag * ratio + n.$real) / denom, (n.$imag - n.$real * ratio) / denom);
};
var $kindBool = 1;
var $kindInt = 2;
var $kindInt8 = 3;
var $kindInt16 = 4;
var $kindInt32 = 5;
var $kindInt64 = 6;
var $kindUint = 7;
var $kindUint8 = 8;
var $kindUint16 = 9;
var $kindUint32 = 10;
var $kindUint64 = 11;
var $kindUintptr = 12;
var $kindFloat32 = 13;
var $kindFloat64 = 14;
var $kindComplex64 = 15;
var $kindComplex128 = 16;
var $kindArray = 17;
var $kindChan = 18;
var $kindFunc = 19;
var $kindInterface = 20;
var $kindMap = 21;
var $kindPtr = 22;
var $kindSlice = 23;
var $kindString = 24;
var $kindStruct = 25;
var $kindUnsafePointer = 26;

var $methodSynthesizers = [];
var $addMethodSynthesizer = f => {
    if ($methodSynthesizers === null) {
        f();
        return;
    }
    $methodSynthesizers.push(f);
};
var $synthesizeMethods = () => {
    $methodSynthesizers.forEach(f => { f(); });
    $methodSynthesizers = null;
};

var $ifaceKeyFor = x => {
    if (x === $ifaceNil) {
        return 'nil';
    }
    var c = x.constructor;
    return c.string + '$' + c.keyFor(x.$val);
};

var $identity = x => { return x; };

var $typeIDCounter = 0;

var $idKey = x => {
    if (x.$id === undefined) {
        $idCounter++;
        x.$id = $idCounter;
    }
    return String(x.$id);
};

// Creates constructor functions for array pointer types. Returns a new function
// instace each time to make sure each type is independent of the other.
var $arrayPtrCtor = () => {
    return function (array) {
        this.$get = () => { return array; };
        this.$set = function (v) { typ.copy(this, v); };
        this.$val = array;
    };
}

var $newType = (size, kind, string, named, pkg, exported, constructor) => {
    var typ;
    switch (kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $identity;
            break;

        case $kindString:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return "$" + x; };
            break;

        case $kindFloat32:
        case $kindFloat64:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return $floatKey(x); };
            break;

        case $kindInt64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindUint64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >>> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindComplex64:
            typ = function (real, imag) {
                this.$real = $fround(real);
                this.$imag = $fround(imag);
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindComplex128:
            typ = function (real, imag) {
                this.$real = real;
                this.$imag = imag;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindArray:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, "", false, $arrayPtrCtor());
            typ.init = (elem, len) => {
                typ.elem = elem;
                typ.len = len;
                typ.comparable = elem.comparable;
                typ.keyFor = x => {
                    return Array.prototype.join.call($mapArray(x, e => {
                        return String(elem.keyFor(e)).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }), "$");
                };
                typ.copy = (dst, src) => {
                    $copyArray(dst, src, 0, 0, src.length, elem);
                };
                typ.ptr.init(typ);
                Object.defineProperty(typ.ptr.nil, "nilCheck", { get: $throwNilPointerError });
            };
            break;

        case $kindChan:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $idKey;
            typ.init = (elem, sendOnly, recvOnly) => {
                typ.elem = elem;
                typ.sendOnly = sendOnly;
                typ.recvOnly = recvOnly;
            };
            break;

        case $kindFunc:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (params, results, variadic) => {
                typ.params = params;
                typ.results = results;
                typ.variadic = variadic;
                typ.comparable = false;
            };
            break;

        case $kindInterface:
            typ = { implementedBy: {}, missingMethodFor: {} };
            typ.keyFor = $ifaceKeyFor;
            typ.init = methods => {
                typ.methods = methods;
                methods.forEach(m => {
                    $ifaceNil[m.prop] = $throwNilPointerError;
                });
            };
            break;

        case $kindMap:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (key, elem) => {
                typ.key = key;
                typ.elem = elem;
                typ.comparable = false;
            };
            break;

        case $kindPtr:
            typ = constructor || function (getter, setter, target) {
                this.$get = getter;
                this.$set = setter;
                this.$target = target;
                this.$val = this;
            };
            typ.keyFor = $idKey;
            typ.init = elem => {
                typ.elem = elem;
                typ.wrapped = (elem.kind === $kindArray);
                typ.nil = new typ($throwNilPointerError, $throwNilPointerError);
            };
            break;

        case $kindSlice:
            typ = function (array) {
                if (array.constructor !== typ.nativeArray) {
                    array = new typ.nativeArray(array);
                }
                this.$array = array;
                this.$offset = 0;
                this.$length = array.length;
                this.$capacity = array.length;
                this.$val = this;
            };
            typ.init = elem => {
                typ.elem = elem;
                typ.comparable = false;
                typ.nativeArray = $nativeArray(elem.kind);
                typ.nil = new typ([]);
            };
            break;

        case $kindStruct:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, pkg, exported, constructor);
            typ.ptr.elem = typ;
            typ.ptr.prototype.$get = function () { return this; };
            typ.ptr.prototype.$set = function (v) { typ.copy(this, v); };
            typ.init = (pkgPath, fields) => {
                typ.pkgPath = pkgPath;
                typ.fields = fields;
                fields.forEach(f => {
                    if (!f.typ.comparable) {
                        typ.comparable = false;
                    }
                });
                typ.keyFor = x => {
                    var val = x.$val;
                    return $mapArray(fields, f => {
                        return String(f.typ.keyFor(val[f.prop])).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }).join("$");
                };
                typ.copy = (dst, src) => {
                    for (var i = 0; i < fields.length; i++) {
                        var f = fields[i];
                        switch (f.typ.kind) {
                            case $kindArray:
                            case $kindStruct:
                                f.typ.copy(dst[f.prop], src[f.prop]);
                                continue;
                            default:
                                dst[f.prop] = src[f.prop];
                                continue;
                        }
                    }
                };
                /* nil value */
                var properties = {};
                fields.forEach(f => {
                    properties[f.prop] = { get: $throwNilPointerError, set: $throwNilPointerError };
                });
                typ.ptr.nil = Object.create(constructor.prototype, properties);
                typ.ptr.nil.$val = typ.ptr.nil;
                /* methods for embedded fields */
                $addMethodSynthesizer(() => {
                    var synthesizeMethod = (target, m, f) => {
                        if (target.prototype[m.prop] !== undefined) { return; }
                        target.prototype[m.prop] = function(...args) {
                            var v = this.$val[f.prop];
                            if (f.typ === $jsObjectPtr) {
                                v = new $jsObjectPtr(v);
                            }
                            if (v.$val === undefined) {
                                v = new f.typ(v);
                            }
                            return v[m.prop](...args);
                        };
                    };
                    fields.forEach(f => {
                        if (f.embedded) {
                            $methodSet(f.typ).forEach(m => {
                                synthesizeMethod(typ, m, f);
                                synthesizeMethod(typ.ptr, m, f);
                            });
                            $methodSet($ptrType(f.typ)).forEach(m => {
                                synthesizeMethod(typ.ptr, m, f);
                            });
                        }
                    });
                });
            };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    switch (kind) {
        case $kindBool:
        case $kindMap:
            typ.zero = () => { return false; };
            break;

        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
        case $kindFloat32:
        case $kindFloat64:
            typ.zero = () => { return 0; };
            break;

        case $kindString:
            typ.zero = () => { return ""; };
            break;

        case $kindInt64:
        case $kindUint64:
        case $kindComplex64:
        case $kindComplex128:
            var zero = new typ(0, 0);
            typ.zero = () => { return zero; };
            break;

        case $kindPtr:
        case $kindSlice:
            typ.zero = () => { return typ.nil; };
            break;

        case $kindChan:
            typ.zero = () => { return $chanNil; };
            break;

        case $kindFunc:
            typ.zero = () => { return $throwNilPointerError; };
            break;

        case $kindInterface:
            typ.zero = () => { return $ifaceNil; };
            break;

        case $kindArray:
            typ.zero = () => {
                var arrayClass = $nativeArray(typ.elem.kind);
                if (arrayClass !== Array) {
                    return new arrayClass(typ.len);
                }
                var array = new Array(typ.len);
                for (var i = 0; i < typ.len; i++) {
                    array[i] = typ.elem.zero();
                }
                return array;
            };
            break;

        case $kindStruct:
            typ.zero = () => { return new typ.ptr(); };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    typ.id = $typeIDCounter;
    $typeIDCounter++;
    typ.size = size;
    typ.kind = kind;
    typ.string = string;
    typ.named = named;
    typ.pkg = pkg;
    typ.exported = exported;
    typ.methods = [];
    typ.methodSetCache = null;
    typ.comparable = true;
    return typ;
};

var $methodSet = typ => {
    if (typ.methodSetCache !== null) {
        return typ.methodSetCache;
    }
    var base = {};

    var isPtr = (typ.kind === $kindPtr);
    if (isPtr && typ.elem.kind === $kindInterface) {
        typ.methodSetCache = [];
        return [];
    }

    var current = [{ typ: isPtr ? typ.elem : typ, indirect: isPtr }];

    var seen = {};

    while (current.length > 0) {
        var next = [];
        var mset = [];

        current.forEach(e => {
            if (seen[e.typ.string]) {
                return;
            }
            seen[e.typ.string] = true;

            if (e.typ.named) {
                mset = mset.concat(e.typ.methods);
                if (e.indirect) {
                    mset = mset.concat($ptrType(e.typ).methods);
                }
            }

            switch (e.typ.kind) {
                case $kindStruct:
                    e.typ.fields.forEach(f => {
                        if (f.embedded) {
                            var fTyp = f.typ;
                            var fIsPtr = (fTyp.kind === $kindPtr);
                            next.push({ typ: fIsPtr ? fTyp.elem : fTyp, indirect: e.indirect || fIsPtr });
                        }
                    });
                    break;

                case $kindInterface:
                    mset = mset.concat(e.typ.methods);
                    break;
            }
        });

        mset.forEach(m => {
            if (base[m.name] === undefined) {
                base[m.name] = m;
            }
        });

        current = next;
    }

    typ.methodSetCache = [];
    Object.keys(base).sort().forEach(name => {
        typ.methodSetCache.push(base[name]);
    });
    return typ.methodSetCache;
};

var $Bool = $newType(1, $kindBool, "bool", true, "", false, null);
var $Int = $newType(4, $kindInt, "int", true, "", false, null);
var $Int8 = $newType(1, $kindInt8, "int8", true, "", false, null);
var $Int16 = $newType(2, $kindInt16, "int16", true, "", false, null);
var $Int32 = $newType(4, $kindInt32, "int32", true, "", false, null);
var $Int64 = $newType(8, $kindInt64, "int64", true, "", false, null);
var $Uint = $newType(4, $kindUint, "uint", true, "", false, null);
var $Uint8 = $newType(1, $kindUint8, "uint8", true, "", false, null);
var $Uint16 = $newType(2, $kindUint16, "uint16", true, "", false, null);
var $Uint32 = $newType(4, $kindUint32, "uint32", true, "", false, null);
var $Uint64 = $newType(8, $kindUint64, "uint64", true, "", false, null);
var $Uintptr = $newType(4, $kindUintptr, "uintptr", true, "", false, null);
var $Float32 = $newType(4, $kindFloat32, "float32", true, "", false, null);
var $Float64 = $newType(8, $kindFloat64, "float64", true, "", false, null);
var $Complex64 = $newType(8, $kindComplex64, "complex64", true, "", false, null);
var $Complex128 = $newType(16, $kindComplex128, "complex128", true, "", false, null);
var $String = $newType(8, $kindString, "string", true, "", false, null);
var $UnsafePointer = $newType(4, $kindUnsafePointer, "unsafe.Pointer", true, "unsafe", false, null);

var $nativeArray = elemKind => {
    switch (elemKind) {
        case $kindInt:
            return Int32Array;
        case $kindInt8:
            return Int8Array;
        case $kindInt16:
            return Int16Array;
        case $kindInt32:
            return Int32Array;
        case $kindUint:
            return Uint32Array;
        case $kindUint8:
            return Uint8Array;
        case $kindUint16:
            return Uint16Array;
        case $kindUint32:
            return Uint32Array;
        case $kindUintptr:
            return Uint32Array;
        case $kindFloat32:
            return Float32Array;
        case $kindFloat64:
            return Float64Array;
        default:
            return Array;
    }
};
var $toNativeArray = (elemKind, array) => {
    var nativeArray = $nativeArray(elemKind);
    if (nativeArray === Array) {
        return array;
    }
    return new nativeArray(array);
};
var $arrayTypes = {};
var $arrayType = (elem, len) => {
    var typeKey = elem.id + "$" + len;
    var typ = $arrayTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(elem.size * len, $kindArray, "[" + len + "]" + elem.string, false, "", false, null);
        $arrayTypes[typeKey] = typ;
        typ.init(elem, len);
    }
    return typ;
};

var $chanType = (elem, sendOnly, recvOnly) => {
    var string = (recvOnly ? "<-" : "") + "chan" + (sendOnly ? "<- " : " ");
    if (!sendOnly && !recvOnly && (elem.string[0] == "<")) {
        string += "(" + elem.string + ")";
    } else {
        string += elem.string;
    }
    var field = sendOnly ? "SendChan" : (recvOnly ? "RecvChan" : "Chan");
    var typ = elem[field];
    if (typ === undefined) {
        typ = $newType(4, $kindChan, string, false, "", false, null);
        elem[field] = typ;
        typ.init(elem, sendOnly, recvOnly);
    }
    return typ;
};
var $Chan = function (elem, capacity) {
    if (capacity < 0 || capacity > 2147483647) {
        $throwRuntimeError("makechan: size out of range");
    }
    this.$elem = elem;
    this.$capacity = capacity;
    this.$buffer = [];
    this.$sendQueue = [];
    this.$recvQueue = [];
    this.$closed = false;
};
var $chanNil = new $Chan(null, 0);
$chanNil.$sendQueue = $chanNil.$recvQueue = { length: 0, push() { }, shift() { return undefined; }, indexOf() { return -1; } };

var $funcTypes = {};
var $funcType = (params, results, variadic) => {
    var typeKey = $mapArray(params, p => { return p.id; }).join(",") + "$" + $mapArray(results, r => { return r.id; }).join(",") + "$" + variadic;
    var typ = $funcTypes[typeKey];
    if (typ === undefined) {
        var paramTypes = $mapArray(params, p => { return p.string; });
        if (variadic) {
            paramTypes[paramTypes.length - 1] = "..." + paramTypes[paramTypes.length - 1].substr(2);
        }
        var string = "func(" + paramTypes.join(", ") + ")";
        if (results.length === 1) {
            string += " " + results[0].string;
        } else if (results.length > 1) {
            string += " (" + $mapArray(results, r => { return r.string; }).join(", ") + ")";
        }
        typ = $newType(4, $kindFunc, string, false, "", false, null);
        $funcTypes[typeKey] = typ;
        typ.init(params, results, variadic);
    }
    return typ;
};

var $interfaceTypes = {};
var $interfaceType = methods => {
    var typeKey = $mapArray(methods, m => { return m.pkg + "," + m.name + "," + m.typ.id; }).join("$");
    var typ = $interfaceTypes[typeKey];
    if (typ === undefined) {
        var string = "interface {}";
        if (methods.length !== 0) {
            string = "interface { " + $mapArray(methods, m => {
                return (m.pkg !== "" ? m.pkg + "." : "") + m.name + m.typ.string.substr(4);
            }).join("; ") + " }";
        }
        typ = $newType(8, $kindInterface, string, false, "", false, null);
        $interfaceTypes[typeKey] = typ;
        typ.init(methods);
    }
    return typ;
};
var $emptyInterface = $interfaceType([]);
var $ifaceNil = {};
var $error = $newType(8, $kindInterface, "error", true, "", false, null);
$error.init([{ prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false) }]);

var $mapTypes = {};
var $mapType = (key, elem) => {
    var typeKey = key.id + "$" + elem.id;
    var typ = $mapTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(4, $kindMap, "map[" + key.string + "]" + elem.string, false, "", false, null);
        $mapTypes[typeKey] = typ;
        typ.init(key, elem);
    }
    return typ;
};
var $makeMap = (keyForFunc, entries) => {
    var m = new Map();
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        m.set(keyForFunc(e.k), e);
    }
    return m;
};

var $ptrType = elem => {
    var typ = elem.ptr;
    if (typ === undefined) {
        typ = $newType(4, $kindPtr, "*" + elem.string, false, "", elem.exported, null);
        elem.ptr = typ;
        typ.init(elem);
    }
    return typ;
};

var $newDataPointer = (data, constructor) => {
    if (constructor.elem.kind === $kindStruct) {
        return data;
    }
    return new constructor(() => { return data; }, v => { data = v; });
};

var $indexPtr = (array, index, constructor) => {
    if (array.buffer) {
        // Pointers to the same underlying ArrayBuffer share cache.
        var cache = array.buffer.$ptr = array.buffer.$ptr || {};
        // Pointers of different primitive types are non-comparable and stored in different caches.
        var typeCache = cache[array.name] = cache[array.name] || {};
        var cacheIdx = array.BYTES_PER_ELEMENT * index + array.byteOffset;
        return typeCache[cacheIdx] || (typeCache[cacheIdx] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    } else {
        array.$ptr = array.$ptr || {};
        return array.$ptr[index] || (array.$ptr[index] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    }
};

var $sliceType = elem => {
    var typ = elem.slice;
    if (typ === undefined) {
        typ = $newType(12, $kindSlice, "[]" + elem.string, false, "", false, null);
        elem.slice = typ;
        typ.init(elem);
    }
    return typ;
};
var $makeSlice = (typ, length, capacity = length) => {
    if (length < 0 || length > 2147483647) {
        $throwRuntimeError("makeslice: len out of range");
    }
    if (capacity < 0 || capacity < length || capacity > 2147483647) {
        $throwRuntimeError("makeslice: cap out of range");
    }
    var array = new typ.nativeArray(capacity);
    if (typ.nativeArray === Array) {
        for (var i = 0; i < capacity; i++) {
            array[i] = typ.elem.zero();
        }
    }
    var slice = new typ(array);
    slice.$length = length;
    return slice;
};

var $structTypes = {};
var $structType = (pkgPath, fields) => {
    var typeKey = $mapArray(fields, f => { return f.name + "," + f.typ.id + "," + f.tag; }).join("$");
    var typ = $structTypes[typeKey];
    if (typ === undefined) {
        var string = "struct { " + $mapArray(fields, f => {
            var str = f.typ.string + (f.tag !== "" ? (" \"" + f.tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") : "");
            if (f.embedded) {
                return str;
            }
            return f.name + " " + str;
        }).join("; ") + " }";
        if (fields.length === 0) {
            string = "struct {}";
        }
        typ = $newType(0, $kindStruct, string, false, "", false, function(...args) {
            this.$val = this;
            for (var i = 0; i < fields.length; i++) {
                var f = fields[i];
                if (f.name == '_') {
                    continue;
                }
                var arg = args[i];
                this[f.prop] = arg !== undefined ? arg : f.typ.zero();
            }
        });
        $structTypes[typeKey] = typ;
        typ.init(pkgPath, fields);
    }
    return typ;
};

var $assertType = (value, type, returnTuple) => {
    var isInterface = (type.kind === $kindInterface), ok, missingMethod = "";
    if (value === $ifaceNil) {
        ok = false;
    } else if (!isInterface) {
        ok = value.constructor === type;
    } else {
        var valueTypeString = value.constructor.string;
        ok = type.implementedBy[valueTypeString];
        if (ok === undefined) {
            ok = true;
            var valueMethodSet = $methodSet(value.constructor);
            var interfaceMethods = type.methods;
            for (var i = 0; i < interfaceMethods.length; i++) {
                var tm = interfaceMethods[i];
                var found = false;
                for (var j = 0; j < valueMethodSet.length; j++) {
                    var vm = valueMethodSet[j];
                    if (vm.name === tm.name && vm.pkg === tm.pkg && vm.typ === tm.typ) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    ok = false;
                    type.missingMethodFor[valueTypeString] = tm.name;
                    break;
                }
            }
            type.implementedBy[valueTypeString] = ok;
        }
        if (!ok) {
            missingMethod = type.missingMethodFor[valueTypeString];
        }
    }

    if (!ok) {
        if (returnTuple) {
            return [type.zero(), false];
        }
        $panic(new $packages["runtime"].TypeAssertionError.ptr(
            $packages["runtime"]._type.ptr.nil,
            (value === $ifaceNil ? $packages["runtime"]._type.ptr.nil : new $packages["runtime"]._type.ptr(value.constructor.string)),
            new $packages["runtime"]._type.ptr(type.string),
            missingMethod));
    }

    if (!isInterface) {
        value = value.$val;
    }
    if (type === $jsObjectPtr) {
        value = value.object;
    }
    return returnTuple ? [value, true] : value;
};
var $stackDepthOffset = 0;
var $getStackDepth = () => {
    var err = new Error();
    if (err.stack === undefined) {
        return undefined;
    }
    return $stackDepthOffset + err.stack.split("\n").length;
};

var $panicStackDepth = null, $panicValue;
var $callDeferred = (deferred, jsErr, fromPanic) => {
    if (!fromPanic && deferred !== null && $curGoroutine.deferStack.indexOf(deferred) == -1) {
        throw jsErr;
    }
    if (jsErr !== null) {
        var newErr = null;
        try {
            $panic(new $jsErrorPtr(jsErr));
        } catch (err) {
            newErr = err;
        }
        $callDeferred(deferred, newErr);
        return;
    }
    if ($curGoroutine.asleep) {
        return;
    }

    $stackDepthOffset--;
    var outerPanicStackDepth = $panicStackDepth;
    var outerPanicValue = $panicValue;

    var localPanicValue = $curGoroutine.panicStack.pop();
    if (localPanicValue !== undefined) {
        $panicStackDepth = $getStackDepth();
        $panicValue = localPanicValue;
    }

    try {
        while (true) {
            if (deferred === null) {
                deferred = $curGoroutine.deferStack[$curGoroutine.deferStack.length - 1];
                if (deferred === undefined) {
                    /* The panic reached the top of the stack. Clear it and throw it as a JavaScript error. */
                    $panicStackDepth = null;
                    if (localPanicValue.Object instanceof Error) {
                        throw localPanicValue.Object;
                    }
                    var msg;
                    if (localPanicValue.constructor === $String) {
                        msg = localPanicValue.$val;
                    } else if (localPanicValue.Error !== undefined) {
                        msg = localPanicValue.Error();
                    } else if (localPanicValue.String !== undefined) {
                        msg = localPanicValue.String();
                    } else {
                        msg = localPanicValue;
                    }
                    throw new Error(msg);
                }
            }
            var call = deferred.pop();
            if (call === undefined) {
                $curGoroutine.deferStack.pop();
                if (localPanicValue !== undefined) {
                    deferred = null;
                    continue;
                }
                return;
            }
            var r = call[0].apply(call[2], call[1]);
            if (r && r.$blk !== undefined) {
                deferred.push([r.$blk, [], r]);
                if (fromPanic) {
                    throw null;
                }
                return;
            }

            if (localPanicValue !== undefined && $panicStackDepth === null) {
                /* error was recovered */
                if (fromPanic) {
                    throw null;
                }
                return;
            }
        }
    } catch (e) {
        // Deferred function threw a JavaScript exception or tries to unwind stack
        // to the point where a panic was handled.
        if (fromPanic) {
            // Re-throw the exception to reach deferral execution call at the end
            // of the function.
            throw e;
        }
        // We are at the end of the function, handle the error or re-throw to
        // continue unwinding if necessary, or simply stop unwinding if we got far
        // enough.
        $callDeferred(deferred, e, fromPanic);
    } finally {
        if (localPanicValue !== undefined) {
            if ($panicStackDepth !== null) {
                $curGoroutine.panicStack.push(localPanicValue);
            }
            $panicStackDepth = outerPanicStackDepth;
            $panicValue = outerPanicValue;
        }
        $stackDepthOffset++;
    }
};

var $panic = value => {
    $curGoroutine.panicStack.push(value);
    $callDeferred(null, null, true);
};
var $recover = () => {
    if ($panicStackDepth === null || ($panicStackDepth !== undefined && $panicStackDepth !== $getStackDepth() - 2)) {
        return $ifaceNil;
    }
    $panicStackDepth = null;
    return $panicValue;
};
var $throw = err => { throw err; };

var $noGoroutine = { asleep: false, exit: false, deferStack: [], panicStack: [] };
var $curGoroutine = $noGoroutine, $totalGoroutines = 0, $awakeGoroutines = 0, $checkForDeadlock = true, $exportedFunctions = 0;
var $mainFinished = false;
var $go = (fun, args) => {
    $totalGoroutines++;
    $awakeGoroutines++;
    var $goroutine = () => {
        try {
            $curGoroutine = $goroutine;
            var r = fun(...args);
            if (r && r.$blk !== undefined) {
                fun = () => { return r.$blk(); };
                args = [];
                return;
            }
            $goroutine.exit = true;
        } catch (err) {
            if (!$goroutine.exit) {
                throw err;
            }
        } finally {
            $curGoroutine = $noGoroutine;
            if ($goroutine.exit) { /* also set by runtime.Goexit() */
                $totalGoroutines--;
                $goroutine.asleep = true;
            }
            if ($goroutine.asleep) {
                $awakeGoroutines--;
                if (!$mainFinished && $awakeGoroutines === 0 && $checkForDeadlock && $exportedFunctions === 0) {
                    console.error("fatal error: all goroutines are asleep - deadlock!");
                    if ($global.process !== undefined) {
                        $global.process.exit(2);
                    }
                }
            }
        }
    };
    $goroutine.asleep = false;
    $goroutine.exit = false;
    $goroutine.deferStack = [];
    $goroutine.panicStack = [];
    $schedule($goroutine);
};

var $scheduled = [];
var $runScheduled = () => {
    // For nested setTimeout calls browsers enforce 4ms minimum delay. We minimize
    // the effect of this penalty by queueing the timer preemptively before we run
    // the goroutines, and later cancelling it if it turns out unneeded. See:
    // https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#nested_timeouts
    var nextRun = setTimeout($runScheduled);
    try {
        var start = Date.now();
        var r;
        while ((r = $scheduled.shift()) !== undefined) {
            r();
            // We need to interrupt this loop in order to allow the event loop to
            // process timers, IO, etc. However, invoking scheduling through
            // setTimeout is ~1000 times more expensive, so we amortize this cost by
            // looping until the 4ms minimal delay has elapsed (assuming there are
            // scheduled goroutines to run), and then yield to the event loop.
            var elapsed = Date.now() - start;
            if (elapsed > 4 || elapsed < 0) { break; }
        }
    } finally {
        if ($scheduled.length == 0) {
            // Cancel scheduling pass if there's nothing to run.
            clearTimeout(nextRun);
        }
    }
};

var $schedule = goroutine => {
    if (goroutine.asleep) {
        goroutine.asleep = false;
        $awakeGoroutines++;
    }
    $scheduled.push(goroutine);
    if ($curGoroutine === $noGoroutine) {
        $runScheduled();
    }
};

var $setTimeout = (f, t) => {
    $awakeGoroutines++;
    return setTimeout(() => {
        $awakeGoroutines--;
        f();
    }, t);
};

var $block = () => {
    if ($curGoroutine === $noGoroutine) {
        $throwRuntimeError("cannot block in JavaScript callback, fix by wrapping code in goroutine");
    }
    $curGoroutine.asleep = true;
};

var $restore = (context, params) => {
    if (context !== undefined && context.$blk !== undefined) {
        return context;
    }
    return params;
}

var $send = (chan, value) => {
    if (chan.$closed) {
        $throwRuntimeError("send on closed channel");
    }
    var queuedRecv = chan.$recvQueue.shift();
    if (queuedRecv !== undefined) {
        queuedRecv([value, true]);
        return;
    }
    if (chan.$buffer.length < chan.$capacity) {
        chan.$buffer.push(value);
        return;
    }

    var thisGoroutine = $curGoroutine;
    var closedDuringSend;
    chan.$sendQueue.push(closed => {
        closedDuringSend = closed;
        $schedule(thisGoroutine);
        return value;
    });
    $block();
    return {
        $blk() {
            if (closedDuringSend) {
                $throwRuntimeError("send on closed channel");
            }
        }
    };
};
var $recv = chan => {
    var queuedSend = chan.$sendQueue.shift();
    if (queuedSend !== undefined) {
        chan.$buffer.push(queuedSend(false));
    }
    var bufferedValue = chan.$buffer.shift();
    if (bufferedValue !== undefined) {
        return [bufferedValue, true];
    }
    if (chan.$closed) {
        return [chan.$elem.zero(), false];
    }

    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.value; } };
    var queueEntry = v => {
        f.value = v;
        $schedule(thisGoroutine);
    };
    chan.$recvQueue.push(queueEntry);
    $block();
    return f;
};
var $close = chan => {
    if (chan.$closed) {
        $throwRuntimeError("close of closed channel");
    }
    chan.$closed = true;
    while (true) {
        var queuedSend = chan.$sendQueue.shift();
        if (queuedSend === undefined) {
            break;
        }
        queuedSend(true); /* will panic */
    }
    while (true) {
        var queuedRecv = chan.$recvQueue.shift();
        if (queuedRecv === undefined) {
            break;
        }
        queuedRecv([chan.$elem.zero(), false]);
    }
};
var $select = comms => {
    var ready = [];
    var selection = -1;
    for (var i = 0; i < comms.length; i++) {
        var comm = comms[i];
        var chan = comm[0];
        switch (comm.length) {
            case 0: /* default */
                selection = i;
                break;
            case 1: /* recv */
                if (chan.$sendQueue.length !== 0 || chan.$buffer.length !== 0 || chan.$closed) {
                    ready.push(i);
                }
                break;
            case 2: /* send */
                if (chan.$closed) {
                    $throwRuntimeError("send on closed channel");
                }
                if (chan.$recvQueue.length !== 0 || chan.$buffer.length < chan.$capacity) {
                    ready.push(i);
                }
                break;
        }
    }

    if (ready.length !== 0) {
        selection = ready[Math.floor(Math.random() * ready.length)];
    }
    if (selection !== -1) {
        var comm = comms[selection];
        switch (comm.length) {
            case 0: /* default */
                return [selection];
            case 1: /* recv */
                return [selection, $recv(comm[0])];
            case 2: /* send */
                $send(comm[0], comm[1]);
                return [selection];
        }
    }

    var entries = [];
    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.selection; } };
    var removeFromQueues = () => {
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var queue = entry[0];
            var index = queue.indexOf(entry[1]);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    };
    for (var i = 0; i < comms.length; i++) {
        (i => {
            var comm = comms[i];
            switch (comm.length) {
                case 1: /* recv */
                    var queueEntry = value => {
                        f.selection = [i, value];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                    };
                    entries.push([comm[0].$recvQueue, queueEntry]);
                    comm[0].$recvQueue.push(queueEntry);
                    break;
                case 2: /* send */
                    var queueEntry = () => {
                        if (comm[0].$closed) {
                            $throwRuntimeError("send on closed channel");
                        }
                        f.selection = [i];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                        return comm[1];
                    };
                    entries.push([comm[0].$sendQueue, queueEntry]);
                    comm[0].$sendQueue.push(queueEntry);
                    break;
            }
        })(i);
    }
    $block();
    return f;
};
var $jsObjectPtr, $jsErrorPtr;

var $needsExternalization = t => {
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return false;
        default:
            return t !== $jsObjectPtr;
    }
};

var $externalize = (v, t, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return v;
        case $kindInt64:
        case $kindUint64:
            return $flatten64(v);
        case $kindArray:
            if ($needsExternalization(t.elem)) {
                return $mapArray(v, e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return v;
        case $kindFunc:
            return $externalizeFunction(v, t, false, makeWrapper);
        case $kindInterface:
            if (v === $ifaceNil) {
                return null;
            }
            if (v.constructor === $jsObjectPtr) {
                return v.$val.object;
            }
            return $externalize(v.$val, v.constructor, makeWrapper);
        case $kindMap:
            if (v.keys === undefined) {
                return null;
            }
            var m = {};
            var keys = Array.from(v.keys());
            for (var i = 0; i < keys.length; i++) {
                var entry = v.get(keys[i]);
                m[$externalize(entry.k, t.key, makeWrapper)] = $externalize(entry.v, t.elem, makeWrapper);
            }
            return m;
        case $kindPtr:
            if (v === t.nil) {
                return null;
            }
            return $externalize(v.$get(), t.elem, makeWrapper);
        case $kindSlice:
            if (v === v.constructor.nil) {
                return null;
            }
            if ($needsExternalization(t.elem)) {
                return $mapArray($sliceToNativeArray(v), e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return $sliceToNativeArray(v);
        case $kindString:
            if ($isASCII(v)) {
                return v;
            }
            var s = "", r;
            for (var i = 0; i < v.length; i += r[1]) {
                r = $decodeRune(v, i);
                var c = r[0];
                if (c > 0xFFFF) {
                    var h = Math.floor((c - 0x10000) / 0x400) + 0xD800;
                    var l = (c - 0x10000) % 0x400 + 0xDC00;
                    s += String.fromCharCode(h, l);
                    continue;
                }
                s += String.fromCharCode(c);
            }
            return s;
        case $kindStruct:
            var timePkg = $packages["time"];
            if (timePkg !== undefined && v.constructor === timePkg.Time.ptr) {
                var milli = $div64(v.UnixNano(), new $Int64(0, 1000000));
                return new Date($flatten64(milli));
            }

            var noJsObject = {};
            var searchJsObject = (v, t) => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                switch (t.kind) {
                    case $kindPtr:
                        if (v === t.nil) {
                            return noJsObject;
                        }
                        return searchJsObject(v.$get(), t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        return searchJsObject(v[f.prop], f.typ);
                    case $kindInterface:
                        return searchJsObject(v.$val, v.constructor);
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(v, t);
            if (o !== noJsObject) {
                return o;
            }

            if (makeWrapper !== undefined) {
                return makeWrapper(v);
            }

            o = {};
            for (var i = 0; i < t.fields.length; i++) {
                var f = t.fields[i];
                if (!f.exported) {
                    continue;
                }
                o[f.name] = $externalize(v[f.prop], f.typ, makeWrapper);
            }
            return o;
    }
    $throwRuntimeError("cannot externalize " + t.string);
};

var $externalizeFunction = (v, t, passThis, makeWrapper) => {
    if (v === $throwNilPointerError) {
        return null;
    }
    if (v.$externalizeWrapper === undefined) {
        $checkForDeadlock = false;
        v.$externalizeWrapper = function () {
            var args = [];
            for (var i = 0; i < t.params.length; i++) {
                if (t.variadic && i === t.params.length - 1) {
                    var vt = t.params[i].elem, varargs = [];
                    for (var j = i; j < arguments.length; j++) {
                        varargs.push($internalize(arguments[j], vt, makeWrapper));
                    }
                    args.push(new (t.params[i])(varargs));
                    break;
                }
                args.push($internalize(arguments[i], t.params[i], makeWrapper));
            }
            var result = v.apply(passThis ? this : undefined, args);
            switch (t.results.length) {
                case 0:
                    return;
                case 1:
                    return $externalize($copyIfRequired(result, t.results[0]), t.results[0], makeWrapper);
                default:
                    for (var i = 0; i < t.results.length; i++) {
                        result[i] = $externalize($copyIfRequired(result[i], t.results[i]), t.results[i], makeWrapper);
                    }
                    return result;
            }
        };
    }
    return v.$externalizeWrapper;
};

var $internalize = (v, t, recv, seen, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    if (t === $jsObjectPtr.elem) {
        $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
    }
    if (v && v.__internal_object__ !== undefined) {
        return $assertType(v.__internal_object__, t, false);
    }
    var timePkg = $packages["time"];
    if (timePkg !== undefined && t === timePkg.Time) {
        if (!(v !== null && v !== undefined && v.constructor === Date)) {
            $throwRuntimeError("cannot internalize time.Time from " + typeof v + ", must be Date");
        }
        return timePkg.Unix(new $Int64(0, 0), new $Int64(0, v.getTime() * 1000000));
    }

    // Cache for values we've already internalized in order to deal with circular
    // references.
    if (seen === undefined) { seen = new Map(); }
    if (!seen.has(t)) { seen.set(t, new Map()); }
    if (seen.get(t).has(v)) { return seen.get(t).get(v); }

    switch (t.kind) {
        case $kindBool:
            return !!v;
        case $kindInt:
            return parseInt(v);
        case $kindInt8:
            return parseInt(v) << 24 >> 24;
        case $kindInt16:
            return parseInt(v) << 16 >> 16;
        case $kindInt32:
            return parseInt(v) >> 0;
        case $kindUint:
            return parseInt(v);
        case $kindUint8:
            return parseInt(v) << 24 >>> 24;
        case $kindUint16:
            return parseInt(v) << 16 >>> 16;
        case $kindUint32:
        case $kindUintptr:
            return parseInt(v) >>> 0;
        case $kindInt64:
        case $kindUint64:
            return new t(0, v);
        case $kindFloat32:
        case $kindFloat64:
            return parseFloat(v);
        case $kindArray:
            if (v.length !== t.len) {
                $throwRuntimeError("got array with wrong size from JavaScript native");
            }
            return $mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); });
        case $kindFunc:
            return function () {
                var args = [];
                for (var i = 0; i < t.params.length; i++) {
                    if (t.variadic && i === t.params.length - 1) {
                        var vt = t.params[i].elem, varargs = arguments[i];
                        for (var j = 0; j < varargs.$length; j++) {
                            args.push($externalize(varargs.$array[varargs.$offset + j], vt, makeWrapper));
                        }
                        break;
                    }
                    args.push($externalize(arguments[i], t.params[i], makeWrapper));
                }
                var result = v.apply(recv, args);
                switch (t.results.length) {
                    case 0:
                        return;
                    case 1:
                        return $internalize(result, t.results[0], makeWrapper);
                    default:
                        for (var i = 0; i < t.results.length; i++) {
                            result[i] = $internalize(result[i], t.results[i], makeWrapper);
                        }
                        return result;
                }
            };
        case $kindInterface:
            if (t.methods.length !== 0) {
                $throwRuntimeError("cannot internalize " + t.string);
            }
            if (v === null) {
                return $ifaceNil;
            }
            if (v === undefined) {
                return new $jsObjectPtr(undefined);
            }
            switch (v.constructor) {
                case Int8Array:
                    return new ($sliceType($Int8))(v);
                case Int16Array:
                    return new ($sliceType($Int16))(v);
                case Int32Array:
                    return new ($sliceType($Int))(v);
                case Uint8Array:
                    return new ($sliceType($Uint8))(v);
                case Uint16Array:
                    return new ($sliceType($Uint16))(v);
                case Uint32Array:
                    return new ($sliceType($Uint))(v);
                case Float32Array:
                    return new ($sliceType($Float32))(v);
                case Float64Array:
                    return new ($sliceType($Float64))(v);
                case Array:
                    return $internalize(v, $sliceType($emptyInterface), makeWrapper);
                case Boolean:
                    return new $Bool(!!v);
                case Date:
                    if (timePkg === undefined) {
                        /* time package is not present, internalize as &js.Object{Date} so it can be externalized into original Date. */
                        return new $jsObjectPtr(v);
                    }
                    return new timePkg.Time($internalize(v, timePkg.Time, makeWrapper));
                case ((() => { })).constructor: // is usually Function, but in Chrome extensions it is something else
                    var funcType = $funcType([$sliceType($emptyInterface)], [$jsObjectPtr], true);
                    return new funcType($internalize(v, funcType, makeWrapper));
                case Number:
                    return new $Float64(parseFloat(v));
                case String:
                    return new $String($internalize(v, $String, makeWrapper));
                default:
                    if ($global.Node && v instanceof $global.Node) {
                        return new $jsObjectPtr(v);
                    }
                    var mapType = $mapType($String, $emptyInterface);
                    return new mapType($internalize(v, mapType, recv, seen, makeWrapper));
            }
        case $kindMap:
            var m = new Map();
            seen.get(t).set(v, m);
            var keys = $keys(v);
            for (var i = 0; i < keys.length; i++) {
                var k = $internalize(keys[i], t.key, recv, seen, makeWrapper);
                m.set(t.key.keyFor(k), { k, v: $internalize(v[keys[i]], t.elem, recv, seen, makeWrapper) });
            }
            return m;
        case $kindPtr:
            if (t.elem.kind === $kindStruct) {
                return $internalize(v, t.elem, makeWrapper);
            }
        case $kindSlice:
            return new t($mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); }));
        case $kindString:
            v = String(v);
            if ($isASCII(v)) {
                return v;
            }
            var s = "";
            var i = 0;
            while (i < v.length) {
                var h = v.charCodeAt(i);
                if (0xD800 <= h && h <= 0xDBFF) {
                    var l = v.charCodeAt(i + 1);
                    var c = (h - 0xD800) * 0x400 + l - 0xDC00 + 0x10000;
                    s += $encodeRune(c);
                    i += 2;
                    continue;
                }
                s += $encodeRune(h);
                i++;
            }
            return s;
        case $kindStruct:
            var noJsObject = {};
            var searchJsObject = t => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                if (t === $jsObjectPtr.elem) {
                    $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
                }
                switch (t.kind) {
                    case $kindPtr:
                        return searchJsObject(t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        var o = searchJsObject(f.typ);
                        if (o !== noJsObject) {
                            var n = new t.ptr();
                            n[f.prop] = o;
                            return n;
                        }
                        return noJsObject;
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(t);
            if (o !== noJsObject) {
                return o;
            }
            var n = new t.ptr();
            for (var i = 0; i < t.fields.length; i++) {
              var f = t.fields[i];
      
              if (!f.exported) {
                continue;
              }
              var jsProp = v[f.name];
      
              n[f.prop] = $internalize(jsProp, f.typ, recv, seen, makeWrapper);
            }
      
            return n;
    }
    $throwRuntimeError("cannot internalize " + t.string);
};

var $copyIfRequired = (v, typ) => {
    // interface values
    if (v && v.constructor && v.constructor.copy) {
        return new v.constructor($clone(v.$val, v.constructor))
    }
    // array and struct values
    if (typ.copy) {
        var clone = typ.zero();
        typ.copy(clone, v);
        return clone;
    }
    return v;
}

/* $isASCII reports whether string s contains only ASCII characters. */
var $isASCII = s => {
    for (var i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) >= 128) {
            return false;
        }
    }
    return true;
};

$packages["github.com/gopherjs/gopherjs/js"] = (function() {
	var $pkg = {}, $init, Object, Error, sliceType, ptrType, ptrType$1, MakeFunc, init;
	Object = $pkg.Object = $newType(0, $kindStruct, "js.Object", true, "github.com/gopherjs/gopherjs/js", true, function(object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.object = null;
			return;
		}
		this.object = object_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "github.com/gopherjs/gopherjs/js", true, function(Object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Object = null;
			return;
		}
		this.Object = Object_;
	});
	sliceType = $sliceType($emptyInterface);
	ptrType = $ptrType(Object);
	ptrType$1 = $ptrType(Error);
	Object.ptr.prototype.Get = function(key) {
		var key, o;
		o = this;
		return o.object[$externalize(key, $String)];
	};
	Object.prototype.Get = function(key) { return this.$val.Get(key); };
	Object.ptr.prototype.Set = function(key, value) {
		var key, o, value;
		o = this;
		o.object[$externalize(key, $String)] = $externalize(value, $emptyInterface);
	};
	Object.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	Object.ptr.prototype.Delete = function(key) {
		var key, o;
		o = this;
		delete o.object[$externalize(key, $String)];
	};
	Object.prototype.Delete = function(key) { return this.$val.Delete(key); };
	Object.ptr.prototype.Length = function() {
		var o;
		o = this;
		return $parseInt(o.object.length);
	};
	Object.prototype.Length = function() { return this.$val.Length(); };
	Object.ptr.prototype.Index = function(i) {
		var i, o;
		o = this;
		return o.object[i];
	};
	Object.prototype.Index = function(i) { return this.$val.Index(i); };
	Object.ptr.prototype.SetIndex = function(i, value) {
		var i, o, value;
		o = this;
		o.object[i] = $externalize(value, $emptyInterface);
	};
	Object.prototype.SetIndex = function(i, value) { return this.$val.SetIndex(i, value); };
	Object.ptr.prototype.Call = function(name, args) {
		var args, name, o, obj;
		o = this;
		return (obj = o.object, obj[$externalize(name, $String)].apply(obj, $externalize(args, sliceType)));
	};
	Object.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	Object.ptr.prototype.Invoke = function(args) {
		var args, o;
		o = this;
		return o.object.apply(undefined, $externalize(args, sliceType));
	};
	Object.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Object.ptr.prototype.New = function(args) {
		var args, o;
		o = this;
		return new ($global.Function.prototype.bind.apply(o.object, [undefined].concat($externalize(args, sliceType))));
	};
	Object.prototype.New = function(args) { return this.$val.New(args); };
	Object.ptr.prototype.Bool = function() {
		var o;
		o = this;
		return !!(o.object);
	};
	Object.prototype.Bool = function() { return this.$val.Bool(); };
	Object.ptr.prototype.String = function() {
		var o;
		o = this;
		return $internalize(o.object, $String);
	};
	Object.prototype.String = function() { return this.$val.String(); };
	Object.ptr.prototype.Int = function() {
		var o;
		o = this;
		return $parseInt(o.object) >> 0;
	};
	Object.prototype.Int = function() { return this.$val.Int(); };
	Object.ptr.prototype.Int64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Int64);
	};
	Object.prototype.Int64 = function() { return this.$val.Int64(); };
	Object.ptr.prototype.Uint64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Uint64);
	};
	Object.prototype.Uint64 = function() { return this.$val.Uint64(); };
	Object.ptr.prototype.Float = function() {
		var o;
		o = this;
		return $parseFloat(o.object);
	};
	Object.prototype.Float = function() { return this.$val.Float(); };
	Object.ptr.prototype.Interface = function() {
		var o;
		o = this;
		return $internalize(o.object, $emptyInterface);
	};
	Object.prototype.Interface = function() { return this.$val.Interface(); };
	Object.ptr.prototype.Unsafe = function() {
		var o;
		o = this;
		return o.object;
	};
	Object.prototype.Unsafe = function() { return this.$val.Unsafe(); };
	Error.ptr.prototype.Error = function() {
		var err;
		err = this;
		return "JavaScript error: " + $internalize(err.Object.message, $String);
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	Error.ptr.prototype.Stack = function() {
		var err;
		err = this;
		return $internalize(err.Object.stack, $String);
	};
	Error.prototype.Stack = function() { return this.$val.Stack(); };
	MakeFunc = function(fn) {
		var fn;
		return $makeFunc(fn);
	};
	$pkg.MakeFunc = MakeFunc;
	init = function() {
		var e;
		e = new Error.ptr(null);
		$unused(e);
	};
	ptrType.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [ptrType], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [ptrType], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType], [ptrType], true)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Int64", name: "Int64", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "Uint64", name: "Uint64", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Unsafe", name: "Unsafe", pkg: "", typ: $funcType([], [$Uintptr], false)}];
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Stack", name: "Stack", pkg: "", typ: $funcType([], [$String], false)}];
	Object.init("github.com/gopherjs/gopherjs/js", [{prop: "object", name: "object", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	Error.init("", [{prop: "Object", name: "Object", embedded: true, exported: true, typ: ptrType, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime"] = (function() {
	var $pkg = {}, $init, js, _type, TypeAssertionError, errorString, ptrType$1, ptrType$2, buildVersion, init, throw$1;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	_type = $pkg._type = $newType(0, $kindStruct, "runtime._type", true, "runtime", false, function(str_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.str = "";
			return;
		}
		this.str = str_;
	});
	TypeAssertionError = $pkg.TypeAssertionError = $newType(0, $kindStruct, "runtime.TypeAssertionError", true, "runtime", true, function(_interface_, concrete_, asserted_, missingMethod_) {
		this.$val = this;
		if (arguments.length === 0) {
			this._interface = ptrType$1.nil;
			this.concrete = ptrType$1.nil;
			this.asserted = ptrType$1.nil;
			this.missingMethod = "";
			return;
		}
		this._interface = _interface_;
		this.concrete = concrete_;
		this.asserted = asserted_;
		this.missingMethod = missingMethod_;
	});
	errorString = $pkg.errorString = $newType(8, $kindString, "runtime.errorString", true, "runtime", false, null);
	ptrType$1 = $ptrType(_type);
	ptrType$2 = $ptrType(TypeAssertionError);
	_type.ptr.prototype.string = function() {
		var t;
		t = this;
		return t.str;
	};
	_type.prototype.string = function() { return this.$val.string(); };
	_type.ptr.prototype.pkgpath = function() {
		var t;
		t = this;
		return "";
	};
	_type.prototype.pkgpath = function() { return this.$val.pkgpath(); };
	TypeAssertionError.ptr.prototype.RuntimeError = function() {
	};
	TypeAssertionError.prototype.RuntimeError = function() { return this.$val.RuntimeError(); };
	TypeAssertionError.ptr.prototype.Error = function() {
		var as, cs, e, inter, msg;
		e = this;
		inter = "interface";
		if (!(e._interface === ptrType$1.nil)) {
			inter = e._interface.string();
		}
		as = e.asserted.string();
		if (e.concrete === ptrType$1.nil) {
			return "interface conversion: " + inter + " is nil, not " + as;
		}
		cs = e.concrete.string();
		if (e.missingMethod === "") {
			msg = "interface conversion: " + inter + " is " + cs + ", not " + as;
			if (cs === as) {
				if (!(e.concrete.pkgpath() === e.asserted.pkgpath())) {
					msg = msg + (" (types from different packages)");
				} else {
					msg = msg + (" (types from different scopes)");
				}
			}
			return msg;
		}
		return "interface conversion: " + cs + " is not " + as + ": missing method " + e.missingMethod;
	};
	TypeAssertionError.prototype.Error = function() { return this.$val.Error(); };
	init = function() {
		var e, jsPkg;
		jsPkg = $packages[$externalize("github.com/gopherjs/gopherjs/js", $String)];
		$jsObjectPtr = jsPkg.Object.ptr;
		$jsErrorPtr = jsPkg.Error.ptr;
		$throwRuntimeError = throw$1;
		buildVersion = $internalize($goVersion, $String);
		e = $ifaceNil;
		e = new TypeAssertionError.ptr(ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, "");
		$unused(e);
	};
	errorString.prototype.RuntimeError = function() {
		var e;
		e = this.$val;
	};
	$ptrType(errorString).prototype.RuntimeError = function() { return new errorString(this.$get()).RuntimeError(); };
	errorString.prototype.Error = function() {
		var e;
		e = this.$val;
		return "runtime error: " + (e);
	};
	$ptrType(errorString).prototype.Error = function() { return new errorString(this.$get()).Error(); };
	throw$1 = function(s) {
		var s;
		$panic(new errorString((s)));
	};
	ptrType$1.methods = [{prop: "string", name: "string", pkg: "runtime", typ: $funcType([], [$String], false)}, {prop: "pkgpath", name: "pkgpath", pkg: "runtime", typ: $funcType([], [$String], false)}];
	ptrType$2.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	_type.init("runtime", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	TypeAssertionError.init("runtime", [{prop: "_interface", name: "_interface", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "concrete", name: "concrete", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "asserted", name: "asserted", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "missingMethod", name: "missingMethod", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buildVersion = "";
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/goarch"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/reflectlite"] = (function() {
	var $pkg = {}, $init, js, goarch, Value, flag, ValueError, Type, Kind, tflag, rtype, method, chanDir, arrayType, chanType, imethod, interfaceType, mapType, ptrType, sliceType, structField, structType, nameOff, typeOff, textOff, errorString, Method, uncommonType, funcType, name, nameData, mapIter, TypeEx, ptrType$1, sliceType$1, sliceType$2, sliceType$3, sliceType$4, ptrType$2, funcType$1, ptrType$4, sliceType$5, ptrType$5, sliceType$6, ptrType$6, ptrType$7, sliceType$7, sliceType$8, sliceType$9, sliceType$10, ptrType$8, structType$2, ptrType$9, arrayType$2, sliceType$13, ptrType$10, funcType$2, ptrType$11, funcType$3, ptrType$12, ptrType$13, kindNames, callHelper, initialized, uint8Type, idJsType, idReflectType, idKindType, idRtype, uncommonTypeMap, nameMap, nameOffList, typeOffList, jsObjectPtr, selectHelper, implements$1, directlyAssignable, haveIdenticalType, haveIdenticalUnderlyingType, toType, ifaceIndir, unquote, init, jsType, reflectType, setKindType, newName, newNameOff, newTypeOff, internalStr, isWrapped, copyStruct, makeValue, TypeOf, ValueOf, FuncOf, SliceOf, unsafe_New, typedmemmove, keyFor, mapaccess, mapiterinit, mapiterkey, mapiternext, maplen, methodReceiver, valueInterface, ifaceE2I, methodName, makeMethodValue, wrapJsObject, unwrapJsObject, getJsTag, PtrTo, copyVal;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	goarch = $packages["internal/goarch"];
	Value = $pkg.Value = $newType(0, $kindStruct, "reflectlite.Value", true, "internal/reflectlite", true, function(typ_, ptr_, flag_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$1.nil;
			this.ptr = 0;
			this.flag = 0;
			return;
		}
		this.typ = typ_;
		this.ptr = ptr_;
		this.flag = flag_;
	});
	flag = $pkg.flag = $newType(4, $kindUintptr, "reflectlite.flag", true, "internal/reflectlite", false, null);
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "reflectlite.ValueError", true, "internal/reflectlite", true, function(Method_, Kind_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Kind = 0;
			return;
		}
		this.Method = Method_;
		this.Kind = Kind_;
	});
	Type = $pkg.Type = $newType(8, $kindInterface, "reflectlite.Type", true, "internal/reflectlite", true, null);
	Kind = $pkg.Kind = $newType(4, $kindUint, "reflectlite.Kind", true, "internal/reflectlite", true, null);
	tflag = $pkg.tflag = $newType(1, $kindUint8, "reflectlite.tflag", true, "internal/reflectlite", false, null);
	rtype = $pkg.rtype = $newType(0, $kindStruct, "reflectlite.rtype", true, "internal/reflectlite", false, function(size_, ptrdata_, hash_, tflag_, align_, fieldAlign_, kind_, equal_, gcdata_, str_, ptrToThis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.size = 0;
			this.ptrdata = 0;
			this.hash = 0;
			this.tflag = 0;
			this.align = 0;
			this.fieldAlign = 0;
			this.kind = 0;
			this.equal = $throwNilPointerError;
			this.gcdata = ptrType$6.nil;
			this.str = 0;
			this.ptrToThis = 0;
			return;
		}
		this.size = size_;
		this.ptrdata = ptrdata_;
		this.hash = hash_;
		this.tflag = tflag_;
		this.align = align_;
		this.fieldAlign = fieldAlign_;
		this.kind = kind_;
		this.equal = equal_;
		this.gcdata = gcdata_;
		this.str = str_;
		this.ptrToThis = ptrToThis_;
	});
	method = $pkg.method = $newType(0, $kindStruct, "reflectlite.method", true, "internal/reflectlite", false, function(name_, mtyp_, ifn_, tfn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.mtyp = 0;
			this.ifn = 0;
			this.tfn = 0;
			return;
		}
		this.name = name_;
		this.mtyp = mtyp_;
		this.ifn = ifn_;
		this.tfn = tfn_;
	});
	chanDir = $pkg.chanDir = $newType(4, $kindInt, "reflectlite.chanDir", true, "internal/reflectlite", false, null);
	arrayType = $pkg.arrayType = $newType(0, $kindStruct, "reflectlite.arrayType", true, "internal/reflectlite", false, function(rtype_, elem_, slice_, len_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.slice = ptrType$1.nil;
			this.len = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.slice = slice_;
		this.len = len_;
	});
	chanType = $pkg.chanType = $newType(0, $kindStruct, "reflectlite.chanType", true, "internal/reflectlite", false, function(rtype_, elem_, dir_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.dir = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.dir = dir_;
	});
	imethod = $pkg.imethod = $newType(0, $kindStruct, "reflectlite.imethod", true, "internal/reflectlite", false, function(name_, typ_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.typ = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
	});
	interfaceType = $pkg.interfaceType = $newType(0, $kindStruct, "reflectlite.interfaceType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.methods = sliceType$9.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.methods = methods_;
	});
	mapType = $pkg.mapType = $newType(0, $kindStruct, "reflectlite.mapType", true, "internal/reflectlite", false, function(rtype_, key_, elem_, bucket_, hasher_, keysize_, valuesize_, bucketsize_, flags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.key = ptrType$1.nil;
			this.elem = ptrType$1.nil;
			this.bucket = ptrType$1.nil;
			this.hasher = $throwNilPointerError;
			this.keysize = 0;
			this.valuesize = 0;
			this.bucketsize = 0;
			this.flags = 0;
			return;
		}
		this.rtype = rtype_;
		this.key = key_;
		this.elem = elem_;
		this.bucket = bucket_;
		this.hasher = hasher_;
		this.keysize = keysize_;
		this.valuesize = valuesize_;
		this.bucketsize = bucketsize_;
		this.flags = flags_;
	});
	ptrType = $pkg.ptrType = $newType(0, $kindStruct, "reflectlite.ptrType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	sliceType = $pkg.sliceType = $newType(0, $kindStruct, "reflectlite.sliceType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	structField = $pkg.structField = $newType(0, $kindStruct, "reflectlite.structField", true, "internal/reflectlite", false, function(name_, typ_, offset_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = new name.ptr(ptrType$6.nil);
			this.typ = ptrType$1.nil;
			this.offset = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
		this.offset = offset_;
	});
	structType = $pkg.structType = $newType(0, $kindStruct, "reflectlite.structType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, fields_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.fields = sliceType$10.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.fields = fields_;
	});
	nameOff = $pkg.nameOff = $newType(4, $kindInt32, "reflectlite.nameOff", true, "internal/reflectlite", false, null);
	typeOff = $pkg.typeOff = $newType(4, $kindInt32, "reflectlite.typeOff", true, "internal/reflectlite", false, null);
	textOff = $pkg.textOff = $newType(4, $kindInt32, "reflectlite.textOff", true, "internal/reflectlite", false, null);
	errorString = $pkg.errorString = $newType(0, $kindStruct, "reflectlite.errorString", true, "internal/reflectlite", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	Method = $pkg.Method = $newType(0, $kindStruct, "reflectlite.Method", true, "internal/reflectlite", true, function(Name_, PkgPath_, Type_, Func_, Index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Func = new Value.ptr(ptrType$1.nil, 0, 0);
			this.Index = 0;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Func = Func_;
		this.Index = Index_;
	});
	uncommonType = $pkg.uncommonType = $newType(0, $kindStruct, "reflectlite.uncommonType", true, "internal/reflectlite", false, function(pkgPath_, mcount_, xcount_, moff_, _methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pkgPath = 0;
			this.mcount = 0;
			this.xcount = 0;
			this.moff = 0;
			this._methods = sliceType$5.nil;
			return;
		}
		this.pkgPath = pkgPath_;
		this.mcount = mcount_;
		this.xcount = xcount_;
		this.moff = moff_;
		this._methods = _methods_;
	});
	funcType = $pkg.funcType = $newType(0, $kindStruct, "reflectlite.funcType", true, "internal/reflectlite", false, function(rtype_, inCount_, outCount_, _in_, _out_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.inCount = 0;
			this.outCount = 0;
			this._in = sliceType$2.nil;
			this._out = sliceType$2.nil;
			return;
		}
		this.rtype = rtype_;
		this.inCount = inCount_;
		this.outCount = outCount_;
		this._in = _in_;
		this._out = _out_;
	});
	name = $pkg.name = $newType(0, $kindStruct, "reflectlite.name", true, "internal/reflectlite", false, function(bytes_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.bytes = ptrType$6.nil;
			return;
		}
		this.bytes = bytes_;
	});
	nameData = $pkg.nameData = $newType(0, $kindStruct, "reflectlite.nameData", true, "internal/reflectlite", false, function(name_, tag_, exported_, embedded_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.tag = "";
			this.exported = false;
			this.embedded = false;
			return;
		}
		this.name = name_;
		this.tag = tag_;
		this.exported = exported_;
		this.embedded = embedded_;
	});
	mapIter = $pkg.mapIter = $newType(0, $kindStruct, "reflectlite.mapIter", true, "internal/reflectlite", false, function(t_, m_, keys_, i_, last_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.t = $ifaceNil;
			this.m = null;
			this.keys = null;
			this.i = 0;
			this.last = null;
			return;
		}
		this.t = t_;
		this.m = m_;
		this.keys = keys_;
		this.i = i_;
		this.last = last_;
	});
	TypeEx = $pkg.TypeEx = $newType(8, $kindInterface, "reflectlite.TypeEx", true, "internal/reflectlite", true, null);
	ptrType$1 = $ptrType(rtype);
	sliceType$1 = $sliceType(name);
	sliceType$2 = $sliceType(ptrType$1);
	sliceType$3 = $sliceType($String);
	sliceType$4 = $sliceType($emptyInterface);
	ptrType$2 = $ptrType(js.Object);
	funcType$1 = $funcType([sliceType$4], [ptrType$2], true);
	ptrType$4 = $ptrType(uncommonType);
	sliceType$5 = $sliceType(method);
	ptrType$5 = $ptrType(funcType);
	sliceType$6 = $sliceType(Value);
	ptrType$6 = $ptrType($Uint8);
	ptrType$7 = $ptrType($UnsafePointer);
	sliceType$7 = $sliceType(Type);
	sliceType$8 = $sliceType(ptrType$2);
	sliceType$9 = $sliceType(imethod);
	sliceType$10 = $sliceType(structField);
	ptrType$8 = $ptrType(nameData);
	structType$2 = $structType("internal/reflectlite", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	ptrType$9 = $ptrType(mapIter);
	arrayType$2 = $arrayType($Uintptr, 2);
	sliceType$13 = $sliceType($Uint8);
	ptrType$10 = $ptrType(ValueError);
	funcType$2 = $funcType([$UnsafePointer, $UnsafePointer], [$Bool], false);
	ptrType$11 = $ptrType(interfaceType);
	funcType$3 = $funcType([$UnsafePointer, $Uintptr], [$Uintptr], false);
	ptrType$12 = $ptrType(structField);
	ptrType$13 = $ptrType(errorString);
	flag.prototype.kind = function() {
		var f;
		f = this.$val;
		return ((((f & 31) >>> 0) >>> 0));
	};
	$ptrType(flag).prototype.kind = function() { return new flag(this.$get()).kind(); };
	flag.prototype.ro = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0))) {
			return 32;
		}
		return 0;
	};
	$ptrType(flag).prototype.ro = function() { return new flag(this.$get()).ro(); };
	Value.ptr.prototype.pointer = function() {
		var v;
		v = this;
		if (!((v.typ.size === 4)) || !v.typ.pointers()) {
			$panic(new $String("can't call pointer on a non-pointer Value"));
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			return (v.ptr).$get();
		}
		return v.ptr;
	};
	Value.prototype.pointer = function() { return this.$val.pointer(); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		if (e.Kind === 0) {
			return "reflect: call of " + e.Method + " on zero Value";
		}
		return "reflect: call of " + e.Method + " on " + new Kind(e.Kind).String() + " Value";
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	flag.prototype.mustBeExported = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
	};
	$ptrType(flag).prototype.mustBeExported = function() { return new flag(this.$get()).mustBeExported(); };
	flag.prototype.mustBeAssignable = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
		if (((f & 256) >>> 0) === 0) {
			$panic(new $String("reflect: " + methodName() + " using unaddressable value"));
		}
	};
	$ptrType(flag).prototype.mustBeAssignable = function() { return new flag(this.$get()).mustBeAssignable(); };
	Value.ptr.prototype.CanSet = function() {
		var v;
		v = this;
		return ((v.flag & 352) >>> 0) === 256;
	};
	Value.prototype.CanSet = function() { return this.$val.CanSet(); };
	Value.ptr.prototype.IsValid = function() {
		var v;
		v = this;
		return !((v.flag === 0));
	};
	Value.prototype.IsValid = function() { return this.$val.IsValid(); };
	Value.ptr.prototype.Kind = function() {
		var v;
		v = this;
		return new flag(v.flag).kind();
	};
	Value.prototype.Kind = function() { return this.$val.Kind(); };
	Value.ptr.prototype.Type = function() {
		var f, v;
		v = this;
		f = v.flag;
		if (f === 0) {
			$panic(new ValueError.ptr("reflectlite.Value.Type", 0));
		}
		return v.typ;
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	structField.ptr.prototype.embedded = function() {
		var f;
		f = this;
		return $clone(f.name, name).embedded();
	};
	structField.prototype.embedded = function() { return this.$val.embedded(); };
	Kind.prototype.String = function() {
		var k;
		k = this.$val;
		if (((k >> 0)) < kindNames.$length) {
			return ((k < 0 || k >= kindNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + k]);
		}
		return (0 >= kindNames.$length ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + 0]);
	};
	$ptrType(Kind).prototype.String = function() { return new Kind(this.$get()).String(); };
	rtype.ptr.prototype.String = function() {
		var s, t;
		t = this;
		s = $clone(t.nameOff(t.str), name).name();
		if (!((((t.tflag & 2) >>> 0) === 0))) {
			return $substring(s, 1);
		}
		return s;
	};
	rtype.prototype.String = function() { return this.$val.String(); };
	rtype.ptr.prototype.Size = function() {
		var t;
		t = this;
		return t.size;
	};
	rtype.prototype.Size = function() { return this.$val.Size(); };
	rtype.ptr.prototype.Kind = function() {
		var t;
		t = this;
		return ((((t.kind & 31) >>> 0) >>> 0));
	};
	rtype.prototype.Kind = function() { return this.$val.Kind(); };
	rtype.ptr.prototype.pointers = function() {
		var t;
		t = this;
		return !((t.ptrdata === 0));
	};
	rtype.prototype.pointers = function() { return this.$val.pointers(); };
	rtype.ptr.prototype.common = function() {
		var t;
		t = this;
		return t;
	};
	rtype.prototype.common = function() { return this.$val.common(); };
	rtype.ptr.prototype.exportedMethods = function() {
		var t, ut;
		t = this;
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return sliceType$5.nil;
		}
		return ut.exportedMethods();
	};
	rtype.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.NumMethod = function() {
		var t, tt;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			return tt.NumMethod();
		}
		return t.exportedMethods().$length;
	};
	rtype.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.PkgPath = function() {
		var t, ut;
		t = this;
		if (((t.tflag & 4) >>> 0) === 0) {
			return "";
		}
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return "";
		}
		return $clone(t.nameOff(ut.pkgPath), name).name();
	};
	rtype.prototype.PkgPath = function() { return this.$val.PkgPath(); };
	rtype.ptr.prototype.hasName = function() {
		var t;
		t = this;
		return !((((t.tflag & 4) >>> 0) === 0));
	};
	rtype.prototype.hasName = function() { return this.$val.hasName(); };
	rtype.ptr.prototype.Name = function() {
		var _1, i, s, sqBrackets, t;
		t = this;
		if (!t.hasName()) {
			return "";
		}
		s = t.String();
		i = s.length - 1 >> 0;
		sqBrackets = 0;
		while (true) {
			if (!(i >= 0 && (!((s.charCodeAt(i) === 46)) || !((sqBrackets === 0))))) { break; }
			_1 = s.charCodeAt(i);
			if (_1 === (93)) {
				sqBrackets = sqBrackets + (1) >> 0;
			} else if (_1 === (91)) {
				sqBrackets = sqBrackets - (1) >> 0;
			}
			i = i - (1) >> 0;
		}
		return $substring(s, (i + 1 >> 0));
	};
	rtype.prototype.Name = function() { return this.$val.Name(); };
	rtype.ptr.prototype.chanDir = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 18))) {
			$panic(new $String("reflect: chanDir of non-chan type"));
		}
		tt = (t.kindType);
		return ((tt.dir >> 0));
	};
	rtype.prototype.chanDir = function() { return this.$val.chanDir(); };
	rtype.ptr.prototype.Elem = function() {
		var _1, t, tt, tt$1, tt$2, tt$3, tt$4;
		t = this;
		_1 = t.Kind();
		if (_1 === (17)) {
			tt = (t.kindType);
			return toType(tt.elem);
		} else if (_1 === (18)) {
			tt$1 = (t.kindType);
			return toType(tt$1.elem);
		} else if (_1 === (21)) {
			tt$2 = (t.kindType);
			return toType(tt$2.elem);
		} else if (_1 === (22)) {
			tt$3 = (t.kindType);
			return toType(tt$3.elem);
		} else if (_1 === (23)) {
			tt$4 = (t.kindType);
			return toType(tt$4.elem);
		}
		$panic(new $String("reflect: Elem of invalid type"));
	};
	rtype.prototype.Elem = function() { return this.$val.Elem(); };
	rtype.ptr.prototype.In = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: In of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.in$(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.In = function(i) { return this.$val.In(i); };
	rtype.ptr.prototype.Len = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 17))) {
			$panic(new $String("reflect: Len of non-array type"));
		}
		tt = (t.kindType);
		return ((tt.len >> 0));
	};
	rtype.prototype.Len = function() { return this.$val.Len(); };
	rtype.ptr.prototype.NumIn = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumIn of non-func type"));
		}
		tt = (t.kindType);
		return ((tt.inCount >> 0));
	};
	rtype.prototype.NumIn = function() { return this.$val.NumIn(); };
	rtype.ptr.prototype.NumOut = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumOut of non-func type"));
		}
		tt = (t.kindType);
		return tt.out().$length;
	};
	rtype.prototype.NumOut = function() { return this.$val.NumOut(); };
	rtype.ptr.prototype.Out = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: Out of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.out(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.Out = function(i) { return this.$val.Out(i); };
	interfaceType.ptr.prototype.NumMethod = function() {
		var t;
		t = this;
		return t.methods.$length;
	};
	interfaceType.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.Implements = function(u) {
		var {_r, t, u, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.Implements"));
		}
		_r = u.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 20))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 20))) { */ case 1:
			$panic(new $String("reflect: non-interface type passed to Type.Implements"));
		/* } */ case 2:
		$s = -1; return implements$1($assertType(u, ptrType$1), t);
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Implements, $c: true, $r, _r, t, u, $s};return $f;
	};
	rtype.prototype.Implements = function(u) { return this.$val.Implements(u); };
	rtype.ptr.prototype.AssignableTo = function(u) {
		var {$24r, _r, t, u, uu, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.AssignableTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = directlyAssignable(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r || implements$1(uu, t);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.AssignableTo, $c: true, $r, $24r, _r, t, u, uu, $s};return $f;
	};
	rtype.prototype.AssignableTo = function(u) { return this.$val.AssignableTo(u); };
	implements$1 = function(T, V) {
		var T, V, i, i$1, j, j$1, t, tm, tm$1, tmName, tmName$1, tmPkgPath, tmPkgPath$1, v, v$1, vm, vm$1, vmName, vmName$1, vmPkgPath, vmPkgPath$1, vmethods, x, x$1, x$2;
		if (!((T.Kind() === 20))) {
			return false;
		}
		t = (T.kindType);
		if (t.methods.$length === 0) {
			return true;
		}
		if (V.Kind() === 20) {
			v = (V.kindType);
			i = 0;
			j = 0;
			while (true) {
				if (!(j < v.methods.$length)) { break; }
				tm = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				tmName = $clone(t.rtype.nameOff(tm.name), name);
				vm = (x$1 = v.methods, ((j < 0 || j >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + j]));
				vmName = $clone(V.nameOff(vm.name), name);
				if ($clone(vmName, name).name() === $clone(tmName, name).name() && V.typeOff(vm.typ) === t.rtype.typeOff(tm.typ)) {
					if (!$clone(tmName, name).isExported()) {
						tmPkgPath = $clone(tmName, name).pkgPath();
						if (tmPkgPath === "") {
							tmPkgPath = $clone(t.pkgPath, name).name();
						}
						vmPkgPath = $clone(vmName, name).pkgPath();
						if (vmPkgPath === "") {
							vmPkgPath = $clone(v.pkgPath, name).name();
						}
						if (!(tmPkgPath === vmPkgPath)) {
							j = j + (1) >> 0;
							continue;
						}
					}
					i = i + (1) >> 0;
					if (i >= t.methods.$length) {
						return true;
					}
				}
				j = j + (1) >> 0;
			}
			return false;
		}
		v$1 = V.uncommon();
		if (v$1 === ptrType$4.nil) {
			return false;
		}
		i$1 = 0;
		vmethods = v$1.methods();
		j$1 = 0;
		while (true) {
			if (!(j$1 < ((v$1.mcount >> 0)))) { break; }
			tm$1 = (x$2 = t.methods, ((i$1 < 0 || i$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$1]));
			tmName$1 = $clone(t.rtype.nameOff(tm$1.name), name);
			vm$1 = $clone(((j$1 < 0 || j$1 >= vmethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : vmethods.$array[vmethods.$offset + j$1]), method);
			vmName$1 = $clone(V.nameOff(vm$1.name), name);
			if ($clone(vmName$1, name).name() === $clone(tmName$1, name).name() && V.typeOff(vm$1.mtyp) === t.rtype.typeOff(tm$1.typ)) {
				if (!$clone(tmName$1, name).isExported()) {
					tmPkgPath$1 = $clone(tmName$1, name).pkgPath();
					if (tmPkgPath$1 === "") {
						tmPkgPath$1 = $clone(t.pkgPath, name).name();
					}
					vmPkgPath$1 = $clone(vmName$1, name).pkgPath();
					if (vmPkgPath$1 === "") {
						vmPkgPath$1 = $clone(V.nameOff(v$1.pkgPath), name).name();
					}
					if (!(tmPkgPath$1 === vmPkgPath$1)) {
						j$1 = j$1 + (1) >> 0;
						continue;
					}
				}
				i$1 = i$1 + (1) >> 0;
				if (i$1 >= t.methods.$length) {
					return true;
				}
			}
			j$1 = j$1 + (1) >> 0;
		}
		return false;
	};
	directlyAssignable = function(T, V) {
		var {$24r, T, V, _r, $s, $r, $c} = $restore(this, {T, V});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		if (T.hasName() && V.hasName() || !((T.Kind() === V.Kind()))) {
			$s = -1; return false;
		}
		_r = haveIdenticalUnderlyingType(T, V, true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: directlyAssignable, $c: true, $r, $24r, T, V, _r, $s};return $f;
	};
	haveIdenticalType = function(T, V, cmpTags) {
		var {$24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (cmpTags) {
			$s = -1; return $interfaceIsEqual(T, V);
		}
		_r = T.Name(); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = V.Name(); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r === _r$1)) { _v = true; $s = 3; continue s; }
		_r$2 = T.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = V.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = !((_r$2 === _r$3)); case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$4 = T.common(); /* */ $s = 8; case 8: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_arg = _r$4;
		_r$5 = V.common(); /* */ $s = 9; case 9: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_arg$1 = _r$5;
		_r$6 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 10; case 10: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		$24r = _r$6;
		$s = 11; case 11: return $24r;
		/* */ } return; } var $f = {$blk: haveIdenticalType, $c: true, $r, $24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s};return $f;
	};
	haveIdenticalUnderlyingType = function(T, V, cmpTags) {
		var {$24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		kind = T.Kind();
		if (!((kind === V.Kind()))) {
			$s = -1; return false;
		}
		if (1 <= kind && kind <= 16 || (kind === 24) || (kind === 26)) {
			$s = -1; return true;
		}
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (18)) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (20)) { $s = 5; continue; }
			/* */ if (_1 === (21)) { $s = 6; continue; }
			/* */ if ((_1 === (22)) || (_1 === (23))) { $s = 7; continue; }
			/* */ if (_1 === (25)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (_1 === (17)) { */ case 2:
				if (!(T.Len() === V.Len())) { _v = false; $s = 10; continue s; }
				_r = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 10:
				$24r = _v;
				$s = 12; case 12: return $24r;
			/* } else if (_1 === (18)) { */ case 3:
				if (!(V.chanDir() === 3)) { _v$1 = false; $s = 15; continue s; }
				_r$1 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 16; case 16: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 15:
				/* */ if (_v$1) { $s = 13; continue; }
				/* */ $s = 14; continue;
				/* if (_v$1) { */ case 13:
					$s = -1; return true;
				/* } */ case 14:
				if (!(V.chanDir() === T.chanDir())) { _v$2 = false; $s = 17; continue s; }
				_r$2 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 18; case 18: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 17:
				$24r$1 = _v$2;
				$s = 19; case 19: return $24r$1;
			/* } else if (_1 === (19)) { */ case 4:
				t = (T.kindType);
				v = (V.kindType);
				if (!((t.outCount === v.outCount)) || !((t.inCount === v.inCount))) {
					$s = -1; return false;
				}
				i = 0;
				/* while (true) { */ case 20:
					/* if (!(i < t.rtype.NumIn())) { break; } */ if(!(i < t.rtype.NumIn())) { $s = 21; continue; }
					_r$3 = haveIdenticalType(t.rtype.In(i), v.rtype.In(i), cmpTags); /* */ $s = 24; case 24: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					/* */ if (!_r$3) { $s = 22; continue; }
					/* */ $s = 23; continue;
					/* if (!_r$3) { */ case 22:
						$s = -1; return false;
					/* } */ case 23:
					i = i + (1) >> 0;
				$s = 20; continue;
				case 21:
				i$1 = 0;
				/* while (true) { */ case 25:
					/* if (!(i$1 < t.rtype.NumOut())) { break; } */ if(!(i$1 < t.rtype.NumOut())) { $s = 26; continue; }
					_r$4 = haveIdenticalType(t.rtype.Out(i$1), v.rtype.Out(i$1), cmpTags); /* */ $s = 29; case 29: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					/* */ if (!_r$4) { $s = 27; continue; }
					/* */ $s = 28; continue;
					/* if (!_r$4) { */ case 27:
						$s = -1; return false;
					/* } */ case 28:
					i$1 = i$1 + (1) >> 0;
				$s = 25; continue;
				case 26:
				$s = -1; return true;
			/* } else if (_1 === (20)) { */ case 5:
				t$1 = (T.kindType);
				v$1 = (V.kindType);
				if ((t$1.methods.$length === 0) && (v$1.methods.$length === 0)) {
					$s = -1; return true;
				}
				$s = -1; return false;
			/* } else if (_1 === (21)) { */ case 6:
				_r$5 = haveIdenticalType(T.Key(), V.Key(), cmpTags); /* */ $s = 31; case 31: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				if (!(_r$5)) { _v$3 = false; $s = 30; continue s; }
				_r$6 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 32; case 32: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				_v$3 = _r$6; case 30:
				$24r$2 = _v$3;
				$s = 33; case 33: return $24r$2;
			/* } else if ((_1 === (22)) || (_1 === (23))) { */ case 7:
				_r$7 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 34; case 34: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
				$24r$3 = _r$7;
				$s = 35; case 35: return $24r$3;
			/* } else if (_1 === (25)) { */ case 8:
				t$2 = (T.kindType);
				v$2 = (V.kindType);
				if (!((t$2.fields.$length === v$2.fields.$length))) {
					$s = -1; return false;
				}
				if (!($clone(t$2.pkgPath, name).name() === $clone(v$2.pkgPath, name).name())) {
					$s = -1; return false;
				}
				_ref = t$2.fields;
				_i = 0;
				/* while (true) { */ case 36:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 37; continue; }
					i$2 = _i;
					tf = (x = t$2.fields, ((i$2 < 0 || i$2 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$2]));
					vf = (x$1 = v$2.fields, ((i$2 < 0 || i$2 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$2]));
					if (!($clone(tf.name, name).name() === $clone(vf.name, name).name())) {
						$s = -1; return false;
					}
					_r$8 = haveIdenticalType(tf.typ, vf.typ, cmpTags); /* */ $s = 40; case 40: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
					/* */ if (!_r$8) { $s = 38; continue; }
					/* */ $s = 39; continue;
					/* if (!_r$8) { */ case 38:
						$s = -1; return false;
					/* } */ case 39:
					if (cmpTags && !($clone(tf.name, name).tag() === $clone(vf.name, name).tag())) {
						$s = -1; return false;
					}
					if (!((tf.offset === vf.offset))) {
						$s = -1; return false;
					}
					if (!(tf.embedded() === vf.embedded())) {
						$s = -1; return false;
					}
					_i++;
				$s = 36; continue;
				case 37:
				$s = -1; return true;
			/* } */ case 9:
		case 1:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: haveIdenticalUnderlyingType, $c: true, $r, $24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s};return $f;
	};
	toType = function(t) {
		var t;
		if (t === ptrType$1.nil) {
			return $ifaceNil;
		}
		return t;
	};
	ifaceIndir = function(t) {
		var t;
		return ((t.kind & 32) >>> 0) === 0;
	};
	Value.ptr.prototype.object = function() {
		var _1, newVal, v, val;
		v = this;
		if ((v.typ.Kind() === 17) || (v.typ.Kind() === 25)) {
			return v.ptr;
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			val = v.ptr.$get();
			if (!(val === $ifaceNil) && !(val.constructor === jsType(v.typ))) {
				switch (0) { default:
					_1 = v.typ.Kind();
					if ((_1 === (11)) || (_1 === (6))) {
						val = new (jsType(v.typ))(val.$high, val.$low);
					} else if ((_1 === (15)) || (_1 === (16))) {
						val = new (jsType(v.typ))(val.$real, val.$imag);
					} else if (_1 === (23)) {
						if (val === val.constructor.nil) {
							val = jsType(v.typ).nil;
							break;
						}
						newVal = new (jsType(v.typ))(val.$array);
						newVal.$offset = val.$offset;
						newVal.$length = val.$length;
						newVal.$capacity = val.$capacity;
						val = newVal;
					}
				}
			}
			return val;
		}
		return v.ptr;
	};
	Value.prototype.object = function() { return this.$val.object(); };
	Value.ptr.prototype.assignTo = function(context, dst, target) {
		var {_r, _r$1, _r$2, context, dst, fl, target, v, x, $s, $r, $c} = $restore(this, {context, dst, target});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue(context, $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
			_r$1 = directlyAssignable(dst, v.typ); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (_r$1) { $s = 5; continue; }
			/* */ if (implements$1(dst, v.typ)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (_r$1) { */ case 5:
				fl = (((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0;
				fl = (fl | (((dst.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(dst, v.ptr, fl);
			/* } else if (implements$1(dst, v.typ)) { */ case 6:
				if (target === 0) {
					target = unsafe_New(dst);
				}
				_r$2 = valueInterface($clone(v, Value)); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				x = _r$2;
				if (dst.NumMethod() === 0) {
					(target).$set(x);
				} else {
					ifaceE2I(dst, x, target);
				}
				$s = -1; return new Value.ptr(dst, target, 148);
			/* } */ case 7:
		case 4:
		$panic(new $String(context + ": value of type " + v.typ.String() + " is not assignable to type " + dst.String()));
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.assignTo, $c: true, $r, _r, _r$1, _r$2, context, dst, fl, target, v, x, $s};return $f;
	};
	Value.prototype.assignTo = function(context, dst, target) { return this.$val.assignTo(context, dst, target); };
	Value.ptr.prototype.Cap = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (17)) {
			return v.typ.Len();
		} else if ((_1 === (18)) || (_1 === (23))) {
			return $parseInt($clone(v, Value).object().$capacity) >> 0;
		}
		$panic(new ValueError.ptr("reflect.Value.Cap", k));
	};
	Value.prototype.Cap = function() { return this.$val.Cap(); };
	Value.ptr.prototype.Index = function(i) {
		var {$24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		a = [a];
		a$1 = [a$1];
		c = [c];
		i = [i];
		typ = [typ];
		typ$1 = [typ$1];
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				tt = (v.typ.kindType);
				if (i[0] < 0 || i[0] > ((tt.len >> 0))) {
					$panic(new $String("reflect: array index out of range"));
				}
				typ[0] = tt.elem;
				fl = (((((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
				a[0] = v.ptr;
				/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 7:
					$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ[0], a[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a[0][i[0]] = unwrapJsObject(typ[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl);
				/* } */ case 8:
				_r = makeValue(typ[0], wrapJsObject(typ[0], a[0][i[0]]), fl); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 10; case 10: return $24r;
			/* } else if (_1 === (23)) { */ case 3:
				s = $clone(v, Value).object();
				if (i[0] < 0 || i[0] >= ($parseInt(s.$length) >> 0)) {
					$panic(new $String("reflect: slice index out of range"));
				}
				tt$1 = (v.typ.kindType);
				typ$1[0] = tt$1.elem;
				fl$1 = (((384 | new flag(v.flag).ro()) >>> 0) | ((typ$1[0].Kind() >>> 0))) >>> 0;
				i[0] = i[0] + (($parseInt(s.$offset) >> 0)) >> 0;
				a$1[0] = s.$array;
				/* */ if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { */ case 11:
					$s = -1; return new Value.ptr(typ$1[0], (new (jsType(PtrTo(typ$1[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ$1[0], a$1[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a$1[0][i[0]] = unwrapJsObject(typ$1[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl$1);
				/* } */ case 12:
				_r$1 = makeValue(typ$1[0], wrapJsObject(typ$1[0], a$1[0][i[0]]), fl$1); /* */ $s = 13; case 13: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 14; case 14: return $24r$1;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i[0] < 0 || i[0] >= str.length) {
					$panic(new $String("reflect: string index out of range"));
				}
				fl$2 = (((new flag(v.flag).ro() | 8) >>> 0) | 128) >>> 0;
				c[0] = str.charCodeAt(i[0]);
				$s = -1; return new Value.ptr(uint8Type, ((c.$ptr || (c.$ptr = new ptrType$6(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, c)))), fl$2);
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Index", k));
			/* } */ case 6:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Index, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s};return $f;
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.InterfaceData = function() {
		var v;
		v = this;
		$panic(new $String("InterfaceData is not supported by GopherJS"));
	};
	Value.prototype.InterfaceData = function() { return this.$val.InterfaceData(); };
	Value.ptr.prototype.IsNil = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (22)) || (_1 === (23))) {
			return $clone(v, Value).object() === jsType(v.typ).nil;
		} else if (_1 === (18)) {
			return $clone(v, Value).object() === $chanNil;
		} else if (_1 === (19)) {
			return $clone(v, Value).object() === $throwNilPointerError;
		} else if (_1 === (21)) {
			return $clone(v, Value).object() === false;
		} else if (_1 === (20)) {
			return $clone(v, Value).object() === $ifaceNil;
		} else if (_1 === (26)) {
			return $clone(v, Value).object() === 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.IsNil", k));
		}
	};
	Value.prototype.IsNil = function() { return this.$val.IsNil(); };
	Value.ptr.prototype.Len = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (17)) || (_1 === (24))) {
			return $parseInt($clone(v, Value).object().length);
		} else if (_1 === (23)) {
			return $parseInt($clone(v, Value).object().$length) >> 0;
		} else if (_1 === (18)) {
			return $parseInt($clone(v, Value).object().$buffer.length) >> 0;
		} else if (_1 === (21)) {
			return $parseInt($clone(v, Value).object().size) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Len", k));
		}
	};
	Value.prototype.Len = function() { return this.$val.Len(); };
	Value.ptr.prototype.Pointer = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (18)) || (_1 === (21)) || (_1 === (22)) || (_1 === (26))) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object();
		} else if (_1 === (19)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return 1;
		} else if (_1 === (23)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object().$array;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Pointer", k));
		}
	};
	Value.prototype.Pointer = function() { return this.$val.Pointer(); };
	Value.ptr.prototype.Set = function(x) {
		var {_1, _r, _r$1, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Set", v.typ, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(x, _r);
		/* */ if (!((((v.flag & 128) >>> 0) === 0))) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (!((((v.flag & 128) >>> 0) === 0))) { */ case 2:
				_1 = v.typ.Kind();
				/* */ if (_1 === (17)) { $s = 5; continue; }
				/* */ if (_1 === (20)) { $s = 6; continue; }
				/* */ if (_1 === (25)) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (_1 === (17)) { */ case 5:
					jsType(v.typ).copy(v.ptr, x.ptr);
					$s = 9; continue;
				/* } else if (_1 === (20)) { */ case 6:
					_r$1 = valueInterface($clone(x, Value)); /* */ $s = 10; case 10: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					v.ptr.$set(_r$1);
					$s = 9; continue;
				/* } else if (_1 === (25)) { */ case 7:
					copyStruct(v.ptr, x.ptr, v.typ);
					$s = 9; continue;
				/* } else { */ case 8:
					v.ptr.$set($clone(x, Value).object());
				/* } */ case 9:
			case 4:
			$s = -1; return;
		/* } */ case 3:
		v.ptr = x.ptr;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Set, $c: true, $r, _1, _r, _r$1, v, x, $s};return $f;
	};
	Value.prototype.Set = function(x) { return this.$val.Set(x); };
	Value.ptr.prototype.SetBytes = function(x) {
		var {_r, _r$1, _v, slice, typedSlice, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 8))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 8))) { */ case 1:
			$panic(new $String("reflect.Value.SetBytes of non-byte slice"));
		/* } */ case 2:
		slice = x;
		if (!(v.typ.Name() === "")) { _v = true; $s = 6; continue s; }
		_r$1 = v.typ.Elem().Name(); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = !(_r$1 === ""); case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			typedSlice = new (jsType(v.typ))(slice.$array);
			typedSlice.$offset = slice.$offset;
			typedSlice.$length = slice.$length;
			typedSlice.$capacity = slice.$capacity;
			slice = typedSlice;
		/* } */ case 5:
		v.ptr.$set(slice);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetBytes, $c: true, $r, _r, _r$1, _v, slice, typedSlice, v, x, $s};return $f;
	};
	Value.prototype.SetBytes = function(x) { return this.$val.SetBytes(x); };
	Value.ptr.prototype.SetCap = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < ($parseInt(s.$length) >> 0) || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice capacity out of range in SetCap"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = s.$length;
		newSlice.$capacity = n;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetCap = function(n) { return this.$val.SetCap(n); };
	Value.ptr.prototype.SetLen = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < 0 || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice length out of range in SetLen"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = n;
		newSlice.$capacity = s.$capacity;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetLen = function(n) { return this.$val.SetLen(n); };
	Value.ptr.prototype.Slice = function(i, j) {
		var {$24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s, $r, $c} = $restore(this, {i, j});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
			kind = new flag(v.flag).kind();
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				if (((v.flag & 256) >>> 0) === 0) {
					$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
				}
				tt = (v.typ.kindType);
				cap = ((tt.len >> 0));
				typ = SliceOf(tt.elem);
				s = new (jsType(typ))($clone(v, Value).object());
				$s = 6; continue;
			/* } else if (_1 === (23)) { */ case 3:
				typ = v.typ;
				s = $clone(v, Value).object();
				cap = $parseInt(s.$capacity) >> 0;
				$s = 6; continue;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i < 0 || j < i || j > str.length) {
					$panic(new $String("reflect.Value.Slice: string slice index out of bounds"));
				}
				_r = ValueOf(new $String($substring(str, i, j))); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 8; case 8: return $24r;
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Slice", kind));
			/* } */ case 6:
		case 1:
		if (i < 0 || j < i || j > cap) {
			$panic(new $String("reflect.Value.Slice: slice index out of bounds"));
		}
		_r$1 = makeValue(typ, $subslice(s, i, j), new flag(v.flag).ro()); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r$1 = _r$1;
		$s = 10; case 10: return $24r$1;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice = function(i, j) { return this.$val.Slice(i, j); };
	Value.ptr.prototype.Slice3 = function(i, j, k) {
		var {$24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s, $r, $c} = $restore(this, {i, j, k});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
		kind = new flag(v.flag).kind();
		_1 = kind;
		if (_1 === (17)) {
			if (((v.flag & 256) >>> 0) === 0) {
				$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
			}
			tt = (v.typ.kindType);
			cap = ((tt.len >> 0));
			typ = SliceOf(tt.elem);
			s = new (jsType(typ))($clone(v, Value).object());
		} else if (_1 === (23)) {
			typ = v.typ;
			s = $clone(v, Value).object();
			cap = $parseInt(s.$capacity) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Slice3", kind));
		}
		if (i < 0 || j < i || k < j || k > cap) {
			$panic(new $String("reflect.Value.Slice3: slice index out of bounds"));
		}
		_r = makeValue(typ, $subslice(s, i, j, k), new flag(v.flag).ro()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice3, $c: true, $r, $24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice3 = function(i, j, k) { return this.$val.Slice3(i, j, k); };
	Value.ptr.prototype.Close = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		$close($clone(v, Value).object());
	};
	Value.prototype.Close = function() { return this.$val.Close(); };
	Value.ptr.prototype.Elem = function() {
		var {$24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (20)) { $s = 2; continue; }
			/* */ if (_1 === (22)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (20)) { */ case 2:
				val = $clone(v, Value).object();
				if (val === $ifaceNil) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				typ = reflectType(val.constructor);
				_r = makeValue(typ, val.$val, new flag(v.flag).ro()); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (22)) { */ case 3:
				if ($clone(v, Value).IsNil()) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				val$1 = $clone(v, Value).object();
				tt = (v.typ.kindType);
				fl = (((((v.flag & 96) >>> 0) | 128) >>> 0) | 256) >>> 0;
				fl = (fl | (((tt.elem.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(tt.elem, (wrapJsObject(tt.elem, val$1)), fl);
			/* } else { */ case 4:
				$panic(new ValueError.ptr("reflect.Value.Elem", k));
			/* } */ case 5:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Elem, $c: true, $r, $24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s};return $f;
	};
	Value.prototype.Elem = function() { return this.$val.Elem(); };
	Value.ptr.prototype.NumField = function() {
		var tt, v;
		v = this;
		new flag(v.flag).mustBe(25);
		tt = (v.typ.kindType);
		return tt.fields.$length;
	};
	Value.prototype.NumField = function() { return this.$val.NumField(); };
	Value.ptr.prototype.MapKeys = function() {
		var {_r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		keyType = tt.key;
		fl = (new flag(v.flag).ro() | ((keyType.Kind() >>> 0))) >>> 0;
		m = $clone(v, Value).pointer();
		mlen = 0;
		if (!(m === 0)) {
			mlen = maplen(m);
		}
		it = mapiterinit(v.typ, m);
		a = $makeSlice(sliceType$6, mlen);
		i = 0;
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < a.$length)) { break; } */ if(!(i < a.$length)) { $s = 2; continue; }
			_r = mapiterkey(it); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			if (key === 0) {
				/* break; */ $s = 2; continue;
			}
			Value.copy(((i < 0 || i >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + i]), copyVal(keyType, fl, key));
			mapiternext(it);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return $subslice(a, 0, i);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapKeys, $c: true, $r, _r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s};return $f;
	};
	Value.prototype.MapKeys = function() { return this.$val.MapKeys(); };
	Value.ptr.prototype.MapIndex = function(key) {
		var {_r, e, fl, k, key, tt, typ, v, $s, $r, $c} = $restore(this, {key});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		_r = $clone(key, Value).assignTo("reflect.Value.MapIndex", tt.key, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(key, _r);
		k = 0;
		if (!((((key.flag & 128) >>> 0) === 0))) {
			k = key.ptr;
		} else {
			k = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$7(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
		}
		e = mapaccess(v.typ, $clone(v, Value).pointer(), k);
		if (e === 0) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		typ = tt.elem;
		fl = new flag((((v.flag | key.flag) >>> 0))).ro();
		fl = (fl | (((typ.Kind() >>> 0)))) >>> 0;
		$s = -1; return copyVal(typ, fl, e);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapIndex, $c: true, $r, _r, e, fl, k, key, tt, typ, v, $s};return $f;
	};
	Value.prototype.MapIndex = function(key) { return this.$val.MapIndex(key); };
	Value.ptr.prototype.Field = function(i) {
		var {$24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		jsTag = [jsTag];
		prop = [prop];
		s = [s];
		typ = [typ];
		v = this;
		if (!((new flag(v.flag).kind() === 25))) {
			$panic(new ValueError.ptr("reflect.Value.Field", new flag(v.flag).kind()));
		}
		tt = (v.typ.kindType);
		if (((i >>> 0)) >= ((tt.fields.$length >>> 0))) {
			$panic(new $String("reflect: Field index out of range"));
		}
		prop[0] = $internalize(jsType(v.typ).fields[i].prop, $String);
		field = (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		typ[0] = field.typ;
		fl = (((v.flag & 416) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
		if (!$clone(field.name, name).isExported()) {
			if (field.embedded()) {
				fl = (fl | (64)) >>> 0;
			} else {
				fl = (fl | (32)) >>> 0;
			}
		}
		tag = $clone((x$1 = tt.fields, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])).name, name).tag();
		/* */ if (!(tag === "") && !((i === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(tag === "") && !((i === 0))) { */ case 1:
			jsTag[0] = getJsTag(tag);
			/* */ if (!(jsTag[0] === "")) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(jsTag[0] === "")) { */ case 3:
				/* while (true) { */ case 5:
					o = [o];
					_r = $clone(v, Value).Field(0); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					Value.copy(v, _r);
					/* */ if (v.typ === jsObjectPtr) { $s = 8; continue; }
					/* */ $s = 9; continue;
					/* if (v.typ === jsObjectPtr) { */ case 8:
						o[0] = $clone(v, Value).object().object;
						$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, o, prop, s, typ) { return function() {
							return $internalize(o[0][$externalize(jsTag[0], $String)], jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ), (function(jsTag, o, prop, s, typ) { return function(x$2) {
							var x$2;
							o[0][$externalize(jsTag[0], $String)] = $externalize(x$2, jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ))), fl);
					/* } */ case 9:
					/* */ if (v.typ.Kind() === 22) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (v.typ.Kind() === 22) { */ case 10:
						_r$1 = $clone(v, Value).Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						Value.copy(v, _r$1);
					/* } */ case 11:
				$s = 5; continue;
				case 6:
			/* } */ case 4:
		/* } */ case 2:
		s[0] = v.ptr;
		/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 13; continue; }
		/* */ $s = 14; continue;
		/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 13:
			$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, prop, s, typ) { return function() {
				return wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]);
			}; })(jsTag, prop, s, typ), (function(jsTag, prop, s, typ) { return function(x$2) {
				var x$2;
				s[0][$externalize(prop[0], $String)] = unwrapJsObject(typ[0], x$2);
			}; })(jsTag, prop, s, typ))), fl);
		/* } */ case 14:
		_r$2 = makeValue(typ[0], wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]), fl); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 16; case 16: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Field, $c: true, $r, $24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s};return $f;
	};
	Value.prototype.Field = function(i) { return this.$val.Field(i); };
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	unquote = function(s) {
		var s;
		if (s.length < 2) {
			return [s, $ifaceNil];
		}
		if ((s.charCodeAt(0) === 39) || (s.charCodeAt(0) === 34)) {
			if (s.charCodeAt((s.length - 1 >> 0)) === s.charCodeAt(0)) {
				return [$substring(s, 1, (s.length - 1 >> 0)), $ifaceNil];
			}
			return ["", $pkg.ErrSyntax];
		}
		return [s, $ifaceNil];
	};
	flag.prototype.mustBe = function(expected) {
		var expected, f;
		f = this.$val;
		if (!((((((f & 31) >>> 0) >>> 0)) === expected))) {
			$panic(new ValueError.ptr(methodName(), new flag(f).kind()));
		}
	};
	$ptrType(flag).prototype.mustBe = function(expected) { return new flag(this.$get()).mustBe(expected); };
	rtype.ptr.prototype.Comparable = function() {
		var {$24r, _1, _r, _r$1, ft, i, t, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
			_1 = t.Kind();
			/* */ if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ if (_1 === (25)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { */ case 2:
				$s = -1; return false;
			/* } else if (_1 === (17)) { */ case 3:
				_r = t.Elem().Comparable(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (25)) { */ case 4:
				i = 0;
				/* while (true) { */ case 8:
					/* if (!(i < t.NumField())) { break; } */ if(!(i < t.NumField())) { $s = 9; continue; }
					ft = $clone(t.Field(i), structField);
					_r$1 = ft.typ.Comparable(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (!_r$1) { */ case 10:
						$s = -1; return false;
					/* } */ case 11:
					i = i + (1) >> 0;
				$s = 8; continue;
				case 9:
			/* } */ case 5:
		case 1:
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Comparable, $c: true, $r, $24r, _1, _r, _r$1, ft, i, t, $s};return $f;
	};
	rtype.prototype.Comparable = function() { return this.$val.Comparable(); };
	rtype.ptr.prototype.IsVariadic = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: IsVariadic of non-func type"));
		}
		tt = (t.kindType);
		return !((((tt.outCount & 32768) >>> 0) === 0));
	};
	rtype.prototype.IsVariadic = function() { return this.$val.IsVariadic(); };
	rtype.ptr.prototype.Field = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: Field of non-struct type"));
		}
		tt = (t.kindType);
		if (i < 0 || i >= tt.fields.$length) {
			$panic(new $String("reflect: Field index out of bounds"));
		}
		return (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
	};
	rtype.prototype.Field = function(i) { return this.$val.Field(i); };
	rtype.ptr.prototype.Key = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 21))) {
			$panic(new $String("reflect: Key of non-map type"));
		}
		tt = (t.kindType);
		return toType(tt.key);
	};
	rtype.prototype.Key = function() { return this.$val.Key(); };
	rtype.ptr.prototype.NumField = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: NumField of non-struct type"));
		}
		tt = (t.kindType);
		return tt.fields.$length;
	};
	rtype.prototype.NumField = function() { return this.$val.NumField(); };
	rtype.ptr.prototype.Method = function(i) {
		var {$24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		prop = [prop];
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		/* */ if (t.Kind() === 20) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (t.Kind() === 20) { */ case 1:
			tt = (t.kindType);
			_r = tt.rtype.Method(i); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Method.copy(m, _r);
			$24r = m;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		methods = t.exportedMethods();
		if (i < 0 || i >= methods.$length) {
			$panic(new $String("reflect: Method index out of range"));
		}
		p = $clone(((i < 0 || i >= methods.$length) ? ($throwRuntimeError("index out of range"), undefined) : methods.$array[methods.$offset + i]), method);
		pname = $clone(t.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		fl = 19;
		mtyp = t.typeOff(p.mtyp);
		ft = (mtyp.kindType);
		in$1 = $makeSlice(sliceType$7, 0, (1 + ft.in$().$length >> 0));
		in$1 = $append(in$1, t);
		_ref = ft.in$();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			in$1 = $append(in$1, arg);
			_i++;
		}
		out = $makeSlice(sliceType$7, 0, ft.out().$length);
		_ref$1 = ft.out();
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			ret = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			out = $append(out, ret);
			_i$1++;
		}
		_r$1 = FuncOf(in$1, out, ft.rtype.IsVariadic()); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		mt = _r$1;
		m.Type = mt;
		prop[0] = $internalize($methodSet(t[$externalize(idJsType, $String)])[i].prop, $String);
		fn = js.MakeFunc((function(prop) { return function(this$1, arguments$1) {
			var arguments$1, rcvr, this$1;
			rcvr = (0 >= arguments$1.$length ? ($throwRuntimeError("index out of range"), undefined) : arguments$1.$array[arguments$1.$offset + 0]);
			return new $jsObjectPtr(rcvr[$externalize(prop[0], $String)].apply(rcvr, $externalize($subslice(arguments$1, 1), sliceType$8)));
		}; })(prop));
		Value.copy(m.Func, new Value.ptr($assertType(mt, ptrType$1), (fn), fl));
		m.Index = i;
		Method.copy(m, m);
		$s = -1; return m;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Method, $c: true, $r, $24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s};return $f;
	};
	rtype.prototype.Method = function(i) { return this.$val.Method(i); };
	init = function() {
		var {used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		used = (function(i) {
			var i;
		});
		$r = used((x = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new x.constructor.elem(x))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$1 = new uncommonType.ptr(0, 0, 0, 0, sliceType$5.nil), new x$1.constructor.elem(x$1))); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$2 = new method.ptr(0, 0, 0, 0), new x$2.constructor.elem(x$2))); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$3 = new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, 0), new x$3.constructor.elem(x$3))); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$4 = new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, 0), new x$4.constructor.elem(x$4))); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$5 = new funcType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), 0, 0, sliceType$2.nil, sliceType$2.nil), new x$5.constructor.elem(x$5))); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$6 = new interfaceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$9.nil), new x$6.constructor.elem(x$6))); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$7 = new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0), new x$7.constructor.elem(x$7))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$8 = new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$8.constructor.elem(x$8))); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$9 = new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$9.constructor.elem(x$9))); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$10 = new structType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$10.nil), new x$10.constructor.elem(x$10))); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$11 = new imethod.ptr(0, 0), new x$11.constructor.elem(x$11))); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$12 = new structField.ptr(new name.ptr(ptrType$6.nil), ptrType$1.nil, 0), new x$12.constructor.elem(x$12))); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		initialized = true;
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: init, $c: true, $r, used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s};return $f;
	};
	jsType = function(typ) {
		var typ;
		return typ[$externalize(idJsType, $String)];
	};
	reflectType = function(typ) {
		var _1, _i, _i$1, _i$2, _i$3, _key, _ref, _ref$1, _ref$2, _ref$3, dir, exported, exported$1, f, fields, i, i$1, i$2, i$3, i$4, i$5, imethods, in$1, m, m$1, m$2, methodSet, methods, out, outCount, params, reflectFields, reflectMethods, results, rt, typ, ut, xcount;
		if (typ[$externalize(idReflectType, $String)] === undefined) {
			rt = new rtype.ptr(((($parseInt(typ.size) >> 0) >>> 0)), 0, 0, 0, 0, 0, ((($parseInt(typ.kind) >> 0) << 24 >>> 24)), $throwNilPointerError, ptrType$6.nil, newNameOff($clone(newName(internalStr(typ.string), "", !!(typ.exported), false), name)), 0);
			rt[$externalize(idJsType, $String)] = typ;
			typ[$externalize(idReflectType, $String)] = rt;
			methodSet = $methodSet(typ);
			if (!(($parseInt(methodSet.length) === 0)) || !!(typ.named)) {
				rt.tflag = (rt.tflag | (1)) >>> 0;
				if (!!(typ.named)) {
					rt.tflag = (rt.tflag | (4)) >>> 0;
				}
				reflectMethods = sliceType$5.nil;
				i = 0;
				while (true) {
					if (!(i < $parseInt(methodSet.length))) { break; }
					m = methodSet[i];
					exported = internalStr(m.pkg) === "";
					if (!exported) {
						i = i + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m.name), "", exported, false), name)), newTypeOff(reflectType(m.typ)), 0, 0));
					i = i + (1) >> 0;
				}
				xcount = ((reflectMethods.$length << 16 >>> 16));
				i$1 = 0;
				while (true) {
					if (!(i$1 < $parseInt(methodSet.length))) { break; }
					m$1 = methodSet[i$1];
					exported$1 = internalStr(m$1.pkg) === "";
					if (exported$1) {
						i$1 = i$1 + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m$1.name), "", exported$1, false), name)), newTypeOff(reflectType(m$1.typ)), 0, 0));
					i$1 = i$1 + (1) >> 0;
				}
				ut = new uncommonType.ptr(newNameOff($clone(newName(internalStr(typ.pkg), "", false, false), name)), (($parseInt(methodSet.length) << 16 >>> 16)), xcount, 0, reflectMethods);
				_key = rt; (uncommonTypeMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$1.keyFor(_key), { k: _key, v: ut });
				ut[$externalize(idJsType, $String)] = typ;
			}
			_1 = rt.Kind();
			if (_1 === (17)) {
				setKindType(rt, new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ptrType$1.nil, ((($parseInt(typ.len) >> 0) >>> 0))));
			} else if (_1 === (18)) {
				dir = 3;
				if (!!(typ.sendOnly)) {
					dir = 2;
				}
				if (!!(typ.recvOnly)) {
					dir = 1;
				}
				setKindType(rt, new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ((dir >>> 0))));
			} else if (_1 === (19)) {
				params = typ.params;
				in$1 = $makeSlice(sliceType$2, $parseInt(params.length));
				_ref = in$1;
				_i = 0;
				while (true) {
					if (!(_i < _ref.$length)) { break; }
					i$2 = _i;
					((i$2 < 0 || i$2 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i$2] = reflectType(params[i$2]));
					_i++;
				}
				results = typ.results;
				out = $makeSlice(sliceType$2, $parseInt(results.length));
				_ref$1 = out;
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					i$3 = _i$1;
					((i$3 < 0 || i$3 >= out.$length) ? ($throwRuntimeError("index out of range"), undefined) : out.$array[out.$offset + i$3] = reflectType(results[i$3]));
					_i$1++;
				}
				outCount = (($parseInt(results.length) << 16 >>> 16));
				if (!!(typ.variadic)) {
					outCount = (outCount | (32768)) >>> 0;
				}
				setKindType(rt, new funcType.ptr($clone(rt, rtype), (($parseInt(params.length) << 16 >>> 16)), outCount, in$1, out));
			} else if (_1 === (20)) {
				methods = typ.methods;
				imethods = $makeSlice(sliceType$9, $parseInt(methods.length));
				_ref$2 = imethods;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					i$4 = _i$2;
					m$2 = methods[i$4];
					imethod.copy(((i$4 < 0 || i$4 >= imethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : imethods.$array[imethods.$offset + i$4]), new imethod.ptr(newNameOff($clone(newName(internalStr(m$2.name), "", internalStr(m$2.pkg) === "", false), name)), newTypeOff(reflectType(m$2.typ))));
					_i$2++;
				}
				setKindType(rt, new interfaceType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkg), "", false, false), name), imethods));
			} else if (_1 === (21)) {
				setKindType(rt, new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.key), reflectType(typ.elem), ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0));
			} else if (_1 === (22)) {
				setKindType(rt, new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (23)) {
				setKindType(rt, new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (25)) {
				fields = typ.fields;
				reflectFields = $makeSlice(sliceType$10, $parseInt(fields.length));
				_ref$3 = reflectFields;
				_i$3 = 0;
				while (true) {
					if (!(_i$3 < _ref$3.$length)) { break; }
					i$5 = _i$3;
					f = fields[i$5];
					structField.copy(((i$5 < 0 || i$5 >= reflectFields.$length) ? ($throwRuntimeError("index out of range"), undefined) : reflectFields.$array[reflectFields.$offset + i$5]), new structField.ptr($clone(newName(internalStr(f.name), internalStr(f.tag), !!(f.exported), !!(f.embedded)), name), reflectType(f.typ), ((i$5 >>> 0))));
					_i$3++;
				}
				setKindType(rt, new structType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkgPath), "", false, false), name), reflectFields));
			}
		}
		return ((typ[$externalize(idReflectType, $String)]));
	};
	setKindType = function(rt, kindType) {
		var kindType, rt;
		rt[$externalize(idKindType, $String)] = kindType;
		kindType[$externalize(idRtype, $String)] = rt;
	};
	uncommonType.ptr.prototype.methods = function() {
		var t;
		t = this;
		return t._methods;
	};
	uncommonType.prototype.methods = function() { return this.$val.methods(); };
	uncommonType.ptr.prototype.exportedMethods = function() {
		var t;
		t = this;
		return $subslice(t._methods, 0, t.xcount, t.xcount);
	};
	uncommonType.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.uncommon = function() {
		var _entry, t;
		t = this;
		return (_entry = $mapIndex(uncommonTypeMap,ptrType$1.keyFor(t)), _entry !== undefined ? _entry.v : ptrType$4.nil);
	};
	rtype.prototype.uncommon = function() { return this.$val.uncommon(); };
	funcType.ptr.prototype.in$ = function() {
		var t;
		t = this;
		return t._in;
	};
	funcType.prototype.in$ = function() { return this.$val.in$(); };
	funcType.ptr.prototype.out = function() {
		var t;
		t = this;
		return t._out;
	};
	funcType.prototype.out = function() { return this.$val.out(); };
	name.ptr.prototype.name = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).name;
		return s;
	};
	name.prototype.name = function() { return this.$val.name(); };
	name.ptr.prototype.tag = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).tag;
		return s;
	};
	name.prototype.tag = function() { return this.$val.tag(); };
	name.ptr.prototype.pkgPath = function() {
		var n;
		n = this;
		return "";
	};
	name.prototype.pkgPath = function() { return this.$val.pkgPath(); };
	name.ptr.prototype.isExported = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).exported;
	};
	name.prototype.isExported = function() { return this.$val.isExported(); };
	name.ptr.prototype.embedded = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).embedded;
	};
	name.prototype.embedded = function() { return this.$val.embedded(); };
	newName = function(n, tag, exported, embedded) {
		var _key, b, embedded, exported, n, tag;
		b = $newDataPointer(0, ptrType$6);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$6.keyFor(_key), { k: _key, v: new nameData.ptr(n, tag, exported, embedded) });
		return new name.ptr(b);
	};
	rtype.ptr.prototype.nameOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= nameOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : nameOffList.$array[nameOffList.$offset + x]));
	};
	rtype.prototype.nameOff = function(off) { return this.$val.nameOff(off); };
	newNameOff = function(n) {
		var i, n;
		i = nameOffList.$length;
		nameOffList = $append(nameOffList, n);
		return ((i >> 0));
	};
	rtype.ptr.prototype.typeOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= typeOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeOffList.$array[typeOffList.$offset + x]));
	};
	rtype.prototype.typeOff = function(off) { return this.$val.typeOff(off); };
	newTypeOff = function(t) {
		var i, t;
		i = typeOffList.$length;
		typeOffList = $append(typeOffList, t);
		return ((i >> 0));
	};
	internalStr = function(strObj) {
		var c, strObj;
		c = new structType$2.ptr("");
		c.str = strObj;
		return c.str;
	};
	isWrapped = function(typ) {
		var typ;
		return !!(jsType(typ).wrapped);
	};
	copyStruct = function(dst, src, typ) {
		var dst, fields, i, prop, src, typ;
		fields = jsType(typ).fields;
		i = 0;
		while (true) {
			if (!(i < $parseInt(fields.length))) { break; }
			prop = $internalize(fields[i].prop, $String);
			dst[$externalize(prop, $String)] = src[$externalize(prop, $String)];
			i = i + (1) >> 0;
		}
	};
	makeValue = function(t, v, fl) {
		var {$24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s, $r, $c} = $restore(this, {t, v, fl});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rt = _r;
		_r$1 = t.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (_r$1 === 17) { _v$1 = true; $s = 5; continue s; }
		_r$2 = t.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 25; case 5:
		if (_v$1) { _v = true; $s = 4; continue s; }
		_r$3 = t.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = _r$3 === 22; case 4:
		/* */ if (_v) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (_v) { */ case 2:
			_r$4 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$24r = new Value.ptr(rt, (v), (fl | ((_r$4 >>> 0))) >>> 0);
			$s = 10; case 10: return $24r;
		/* } */ case 3:
		_r$5 = t.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(rt, ($newDataPointer(v, jsType(rt.ptrTo()))), (((fl | ((_r$5 >>> 0))) >>> 0) | 128) >>> 0);
		$s = 12; case 12: return $24r$1;
		/* */ } return; } var $f = {$blk: makeValue, $c: true, $r, $24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s};return $f;
	};
	TypeOf = function(i) {
		var i;
		if (!initialized) {
			return new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
		}
		if ($interfaceIsEqual(i, $ifaceNil)) {
			return $ifaceNil;
		}
		return reflectType(i.constructor);
	};
	$pkg.TypeOf = TypeOf;
	ValueOf = function(i) {
		var {$24r, _r, i, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(i, $ifaceNil)) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = makeValue(reflectType(i.constructor), i.$val, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ValueOf, $c: true, $r, $24r, _r, i, $s};return $f;
	};
	$pkg.ValueOf = ValueOf;
	FuncOf = function(in$1, out, variadic) {
		var {_i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s, $r, $c} = $restore(this, {in$1, out, variadic});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (!(variadic)) { _v = false; $s = 3; continue s; }
		if (in$1.$length === 0) { _v$1 = true; $s = 4; continue s; }
		_r = (x = in$1.$length - 1 >> 0, ((x < 0 || x >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x])).Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v$1 = !((_r === 23)); case 4:
		_v = _v$1; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$panic(new $String("reflect.FuncOf: last arg of variadic func must be slice"));
		/* } */ case 2:
		jsIn = $makeSlice(sliceType$8, in$1.$length);
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= jsIn.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsIn.$array[jsIn.$offset + i] = jsType(v));
			_i++;
		}
		jsOut = $makeSlice(sliceType$8, out.$length);
		_ref$1 = out;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i$1 = _i$1;
			v$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			((i$1 < 0 || i$1 >= jsOut.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsOut.$array[jsOut.$offset + i$1] = jsType(v$1));
			_i$1++;
		}
		$s = -1; return reflectType($funcType($externalize(jsIn, sliceType$8), $externalize(jsOut, sliceType$8), $externalize(variadic, $Bool)));
		/* */ } return; } var $f = {$blk: FuncOf, $c: true, $r, _i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s};return $f;
	};
	$pkg.FuncOf = FuncOf;
	rtype.ptr.prototype.ptrTo = function() {
		var t;
		t = this;
		return reflectType($ptrType(jsType(t)));
	};
	rtype.prototype.ptrTo = function() { return this.$val.ptrTo(); };
	SliceOf = function(t) {
		var t;
		return reflectType($sliceType(jsType(t)));
	};
	$pkg.SliceOf = SliceOf;
	unsafe_New = function(typ) {
		var _1, typ;
		_1 = typ.Kind();
		if (_1 === (25)) {
			return (new (jsType(typ).ptr)());
		} else if (_1 === (17)) {
			return (jsType(typ).zero());
		} else {
			return ($newDataPointer(jsType(typ).zero(), jsType(typ.ptrTo())));
		}
	};
	typedmemmove = function(t, dst, src) {
		var dst, src, t;
		dst.$set(src.$get());
	};
	keyFor = function(t, key) {
		var k, key, kv, t;
		kv = key;
		if (!(kv.$get === undefined)) {
			kv = kv.$get();
		}
		k = $internalize(jsType(t.Key()).keyFor(kv), $String);
		return [kv, k];
	};
	mapaccess = function(t, m, key) {
		var _tuple, entry, k, key, m, t;
		_tuple = keyFor(t, key);
		k = _tuple[1];
		entry = m.get($externalize(k, $String));
		if (entry === undefined) {
			return 0;
		}
		return ($newDataPointer(entry.v, jsType(PtrTo(t.Elem()))));
	};
	mapIter.ptr.prototype.skipUntilValidKey = function() {
		var iter, k;
		iter = this;
		while (true) {
			if (!(iter.i < $parseInt(iter.keys.length))) { break; }
			k = iter.keys[iter.i];
			if (!(iter.m.get(k) === undefined)) {
				break;
			}
			iter.i = iter.i + (1) >> 0;
		}
	};
	mapIter.prototype.skipUntilValidKey = function() { return this.$val.skipUntilValidKey(); };
	mapiterinit = function(t, m) {
		var m, t;
		return (new mapIter.ptr(t, m, $global.Array.from(m.keys()), 0, null));
	};
	mapiterkey = function(it) {
		var {$24r, _r, _r$1, _r$2, it, iter, k, kv, $s, $r, $c} = $restore(this, {it});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = ($pointerOfStructConversion(it, ptrType$9));
		kv = null;
		if (!(iter.last === null)) {
			kv = iter.last;
		} else {
			iter.skipUntilValidKey();
			if (iter.i === $parseInt(iter.keys.length)) {
				$s = -1; return 0;
			}
			k = iter.keys[iter.i];
			kv = iter.m.get(k);
			iter.last = kv;
		}
		_r = $assertType(iter.t, TypeEx).Key(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.k, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: mapiterkey, $c: true, $r, $24r, _r, _r$1, _r$2, it, iter, k, kv, $s};return $f;
	};
	mapiternext = function(it) {
		var it, iter;
		iter = ($pointerOfStructConversion(it, ptrType$9));
		iter.last = null;
		iter.i = iter.i + (1) >> 0;
	};
	maplen = function(m) {
		var m;
		return $parseInt(m.size) >> 0;
	};
	methodReceiver = function(op, v, i) {
		var _, fn, i, m, m$1, ms, op, prop, rcvr, t, tt, v, x;
		_ = ptrType$1.nil;
		t = ptrType$5.nil;
		fn = 0;
		prop = "";
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (i < 0 || i >= tt.methods.$length) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if (!$clone(tt.rtype.nameOff(m.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (tt.rtype.typeOff(m.typ).kindType);
			prop = $clone(tt.rtype.nameOff(m.name), name).name();
		} else {
			ms = v.typ.exportedMethods();
			if (((i >>> 0)) >= ((ms.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
			if (!$clone(v.typ.nameOff(m$1.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (v.typ.typeOff(m$1.mtyp).kindType);
			prop = $internalize($methodSet(jsType(v.typ))[i].prop, $String);
		}
		rcvr = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr = new (jsType(v.typ))(rcvr);
		}
		fn = (rcvr[$externalize(prop, $String)]);
		return [_, t, fn];
	};
	valueInterface = function(v) {
		var {_r, cv, v, $s, $r, $c} = $restore(this, {v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Interface", 0));
		}
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Interface", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
		if (isWrapped(v.typ)) {
			if (!((((v.flag & 128) >>> 0) === 0)) && ($clone(v, Value).Kind() === 25)) {
				cv = jsType(v.typ).zero();
				copyStruct(cv, $clone(v, Value).object(), v.typ);
				$s = -1; return ((new (jsType(v.typ))(cv)));
			}
			$s = -1; return ((new (jsType(v.typ))($clone(v, Value).object())));
		}
		$s = -1; return (($clone(v, Value).object()));
		/* */ } return; } var $f = {$blk: valueInterface, $c: true, $r, _r, cv, v, $s};return $f;
	};
	ifaceE2I = function(t, src, dst) {
		var dst, src, t;
		dst.$set(src);
	};
	methodName = function() {
		return "?FIXME?";
	};
	makeMethodValue = function(op, v) {
		var {$24r, _r, _tuple, fn, fv, op, rcvr, v, $s, $r, $c} = $restore(this, {op, v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		fn = [fn];
		rcvr = [rcvr];
		if (((v.flag & 512) >>> 0) === 0) {
			$panic(new $String("reflect: internal error: invalid use of makePartialFunc"));
		}
		_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
		fn[0] = _tuple[2];
		rcvr[0] = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr[0] = new (jsType(v.typ))(rcvr[0]);
		}
		fv = js.MakeFunc((function(fn, rcvr) { return function(this$1, arguments$1) {
			var arguments$1, this$1;
			return new $jsObjectPtr(fn[0].apply(rcvr[0], $externalize(arguments$1, sliceType$8)));
		}; })(fn, rcvr));
		_r = $clone(v, Value).Type().common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r, (fv), (new flag(v.flag).ro() | 19) >>> 0);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: makeMethodValue, $c: true, $r, $24r, _r, _tuple, fn, fv, op, rcvr, v, $s};return $f;
	};
	wrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return new (jsType(jsObjectPtr))(val);
		}
		return val;
	};
	unwrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return val.object;
		}
		return val;
	};
	getJsTag = function(tag) {
		var _tuple, i, name$1, qvalue, tag, value;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 32)) && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (name$1 === "js") {
				_tuple = unquote(qvalue);
				value = _tuple[0];
				return value;
			}
		}
		return "";
	};
	PtrTo = function(t) {
		var t;
		return $assertType(t, ptrType$1).ptrTo();
	};
	$pkg.PtrTo = PtrTo;
	copyVal = function(typ, fl, ptr) {
		var c, fl, ptr, typ;
		if (ifaceIndir(typ)) {
			c = unsafe_New(typ);
			typedmemmove(typ, c, ptr);
			return new Value.ptr(typ, c, (fl | 128) >>> 0);
		}
		return new Value.ptr(typ, (ptr).$get(), fl);
	};
	Value.methods = [{prop: "pointer", name: "pointer", pkg: "internal/reflectlite", typ: $funcType([], [$UnsafePointer], false)}, {prop: "CanSet", name: "CanSet", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsValid", name: "IsValid", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "numMethod", name: "numMethod", pkg: "internal/reflectlite", typ: $funcType([], [$Int], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}, {prop: "object", name: "object", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$2], false)}, {prop: "assignTo", name: "assignTo", pkg: "internal/reflectlite", typ: $funcType([$String, ptrType$1, $UnsafePointer], [Value], false)}, {prop: "call", name: "call", pkg: "internal/reflectlite", typ: $funcType([$String, sliceType$6], [sliceType$6], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "InterfaceData", name: "InterfaceData", pkg: "", typ: $funcType([], [arrayType$2], false)}, {prop: "IsNil", name: "IsNil", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Pointer", name: "Pointer", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([Value], [], false)}, {prop: "SetBytes", name: "SetBytes", pkg: "", typ: $funcType([sliceType$13], [], false)}, {prop: "SetCap", name: "SetCap", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "SetLen", name: "SetLen", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Slice", name: "Slice", pkg: "", typ: $funcType([$Int, $Int], [Value], false)}, {prop: "Slice3", name: "Slice3", pkg: "", typ: $funcType([$Int, $Int, $Int], [Value], false)}, {prop: "Close", name: "Close", pkg: "", typ: $funcType([], [], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Value], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MapKeys", name: "MapKeys", pkg: "", typ: $funcType([], [sliceType$6], false)}, {prop: "MapIndex", name: "MapIndex", pkg: "", typ: $funcType([Value], [Value], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [Value], false)}];
	flag.methods = [{prop: "kind", name: "kind", pkg: "internal/reflectlite", typ: $funcType([], [Kind], false)}, {prop: "ro", name: "ro", pkg: "internal/reflectlite", typ: $funcType([], [flag], false)}, {prop: "mustBeExported", name: "mustBeExported", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBeAssignable", name: "mustBeAssignable", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBe", name: "mustBe", pkg: "internal/reflectlite", typ: $funcType([Kind], [], false)}];
	ptrType$10.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Kind.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$1.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "pointers", name: "pointers", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "hasName", name: "hasName", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "chanDir", name: "chanDir", pkg: "internal/reflectlite", typ: $funcType([], [chanDir], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "kindType", name: "kindType", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [structField], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}, {prop: "nameOff", name: "nameOff", pkg: "internal/reflectlite", typ: $funcType([nameOff], [name], false)}, {prop: "typeOff", name: "typeOff", pkg: "internal/reflectlite", typ: $funcType([typeOff], [ptrType$1], false)}, {prop: "ptrTo", name: "ptrTo", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}];
	ptrType$11.methods = [{prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}];
	ptrType$12.methods = [{prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$13.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$4.methods = [{prop: "methods", name: "methods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}];
	ptrType$5.methods = [{prop: "in$", name: "in", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}, {prop: "out", name: "out", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}];
	name.methods = [{prop: "data", name: "data", pkg: "internal/reflectlite", typ: $funcType([$Int, $String], [ptrType$6], false)}, {prop: "hasTag", name: "hasTag", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "readVarint", name: "readVarint", pkg: "internal/reflectlite", typ: $funcType([$Int], [$Int, $Int], false)}, {prop: "name", name: "name", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "tag", name: "tag", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "pkgPath", name: "pkgPath", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "isExported", name: "isExported", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$9.methods = [{prop: "skipUntilValidKey", name: "skipUntilValidKey", pkg: "internal/reflectlite", typ: $funcType([], [], false)}];
	Value.init("internal/reflectlite", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "ptr", name: "ptr", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "flag", name: "flag", embedded: true, exported: false, typ: flag, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Kind", name: "Kind", embedded: false, exported: true, typ: Kind, tag: ""}]);
	Type.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	rtype.init("internal/reflectlite", [{prop: "size", name: "size", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "ptrdata", name: "ptrdata", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "hash", name: "hash", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "tflag", name: "tflag", embedded: false, exported: false, typ: tflag, tag: ""}, {prop: "align", name: "align", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "fieldAlign", name: "fieldAlign", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "kind", name: "kind", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "equal", name: "equal", embedded: false, exported: false, typ: funcType$2, tag: ""}, {prop: "gcdata", name: "gcdata", embedded: false, exported: false, typ: ptrType$6, tag: ""}, {prop: "str", name: "str", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "ptrToThis", name: "ptrToThis", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	method.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mtyp", name: "mtyp", embedded: false, exported: false, typ: typeOff, tag: ""}, {prop: "ifn", name: "ifn", embedded: false, exported: false, typ: textOff, tag: ""}, {prop: "tfn", name: "tfn", embedded: false, exported: false, typ: textOff, tag: ""}]);
	arrayType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "slice", name: "slice", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "len", name: "len", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	chanType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "dir", name: "dir", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	imethod.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	interfaceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "methods", name: "methods", embedded: false, exported: false, typ: sliceType$9, tag: ""}]);
	mapType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "bucket", name: "bucket", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "hasher", name: "hasher", embedded: false, exported: false, typ: funcType$3, tag: ""}, {prop: "keysize", name: "keysize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "valuesize", name: "valuesize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "bucketsize", name: "bucketsize", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "flags", name: "flags", embedded: false, exported: false, typ: $Uint32, tag: ""}]);
	ptrType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	sliceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	structField.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: name, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "offset", name: "offset", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	structType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "fields", name: "fields", embedded: false, exported: false, typ: sliceType$10, tag: ""}]);
	errorString.init("internal/reflectlite", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	Method.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: Value, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: $Int, tag: ""}]);
	uncommonType.init("internal/reflectlite", [{prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mcount", name: "mcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "xcount", name: "xcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "moff", name: "moff", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "_methods", name: "_methods", embedded: false, exported: false, typ: sliceType$5, tag: ""}]);
	funcType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: "reflect:\"func\""}, {prop: "inCount", name: "inCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "outCount", name: "outCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "_in", name: "_in", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "_out", name: "_out", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	name.init("internal/reflectlite", [{prop: "bytes", name: "bytes", embedded: false, exported: false, typ: ptrType$6, tag: ""}]);
	nameData.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "exported", name: "exported", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "embedded", name: "embedded", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	mapIter.init("internal/reflectlite", [{prop: "t", name: "t", embedded: false, exported: false, typ: Type, tag: ""}, {prop: "m", name: "m", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "keys", name: "keys", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "i", name: "i", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "last", name: "last", embedded: false, exported: false, typ: ptrType$2, tag: ""}]);
	TypeEx.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = goarch.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		uint8Type = ptrType$1.nil;
		nameOffList = sliceType$1.nil;
		typeOffList = sliceType$2.nil;
		kindNames = new sliceType$3(["invalid", "bool", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "array", "chan", "func", "interface", "map", "ptr", "slice", "string", "struct", "unsafe.Pointer"]);
		callHelper = $assertType($internalize($call, $emptyInterface), funcType$1);
		$pkg.ErrSyntax = new errorString.ptr("invalid syntax");
		initialized = false;
		idJsType = "_jsType";
		idReflectType = "_reflectType";
		idKindType = "kindType";
		idRtype = "_rtype";
		uncommonTypeMap = new $global.Map();
		nameMap = new $global.Map();
		jsObjectPtr = reflectType($jsObjectPtr);
		selectHelper = $assertType($internalize($select, $emptyInterface), funcType$1);
		$r = init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["errors"] = (function() {
	var $pkg = {}, $init, reflectlite, errorString, ptrType, ptrType$1, errorType, _r, New;
	reflectlite = $packages["internal/reflectlite"];
	errorString = $pkg.errorString = $newType(0, $kindStruct, "errors.errorString", true, "errors", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	ptrType = $ptrType($error);
	ptrType$1 = $ptrType(errorString);
	New = function(text) {
		var text;
		return new errorString.ptr(text);
	};
	$pkg.New = New;
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.init("errors", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflectlite.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_r = reflectlite.TypeOf((ptrType.nil)).Elem(); /* */ $s = 2; case 2: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		errorType = _r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/cpu"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/bytealg"] = (function() {
	var $pkg = {}, $init, cpu;
	cpu = $packages["internal/cpu"];
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = cpu.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math/bits"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math"] = (function() {
	var $pkg = {}, $init, js, bits, arrayType, arrayType$1, arrayType$2, structType, math, nan, buf, init;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	bits = $packages["math/bits"];
	arrayType = $arrayType($Uint32, 2);
	arrayType$1 = $arrayType($Float32, 2);
	arrayType$2 = $arrayType($Float64, 1);
	structType = $structType("math", [{prop: "uint32array", name: "uint32array", embedded: false, exported: false, typ: arrayType, tag: ""}, {prop: "float32array", name: "float32array", embedded: false, exported: false, typ: arrayType$1, tag: ""}, {prop: "float64array", name: "float64array", embedded: false, exported: false, typ: arrayType$2, tag: ""}]);
	init = function() {
		var ab;
		ab = new ($global.ArrayBuffer)(8);
		buf.uint32array = new ($global.Uint32Array)(ab);
		buf.float32array = new ($global.Float32Array)(ab);
		buf.float64array = new ($global.Float64Array)(ab);
	};
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buf = new structType.ptr(arrayType.zero(), arrayType$1.zero(), arrayType$2.zero());
		math = $global.Math;
		nan = $parseFloat($NaN);
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["unicode/utf8"] = (function() {
	var $pkg = {}, $init, acceptRange, first, acceptRanges, DecodeRuneInString, EncodeRune, ValidRune;
	acceptRange = $pkg.acceptRange = $newType(0, $kindStruct, "utf8.acceptRange", true, "unicode/utf8", false, function(lo_, hi_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.lo = 0;
			this.hi = 0;
			return;
		}
		this.lo = lo_;
		this.hi = hi_;
	});
	DecodeRuneInString = function(s) {
		var _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, accept, mask, n, r, s, s0, s1, s2, s3, size, sz, x, x$1;
		r = 0;
		size = 0;
		n = s.length;
		if (n < 1) {
			_tmp = 65533;
			_tmp$1 = 0;
			r = _tmp;
			size = _tmp$1;
			return [r, size];
		}
		s0 = s.charCodeAt(0);
		x = ((s0 < 0 || s0 >= first.length) ? ($throwRuntimeError("index out of range"), undefined) : first[s0]);
		if (x >= 240) {
			mask = (((x >> 0)) << 31 >> 0) >> 31 >> 0;
			_tmp$2 = ((((s.charCodeAt(0) >> 0)) & ~mask) >> 0) | (65533 & mask);
			_tmp$3 = 1;
			r = _tmp$2;
			size = _tmp$3;
			return [r, size];
		}
		sz = ((((x & 7) >>> 0) >> 0));
		accept = $clone((x$1 = x >>> 4 << 24 >>> 24, ((x$1 < 0 || x$1 >= acceptRanges.length) ? ($throwRuntimeError("index out of range"), undefined) : acceptRanges[x$1])), acceptRange);
		if (n < sz) {
			_tmp$4 = 65533;
			_tmp$5 = 1;
			r = _tmp$4;
			size = _tmp$5;
			return [r, size];
		}
		s1 = s.charCodeAt(1);
		if (s1 < accept.lo || accept.hi < s1) {
			_tmp$6 = 65533;
			_tmp$7 = 1;
			r = _tmp$6;
			size = _tmp$7;
			return [r, size];
		}
		if (sz <= 2) {
			_tmp$8 = (((((s0 & 31) >>> 0) >> 0)) << 6 >> 0) | ((((s1 & 63) >>> 0) >> 0));
			_tmp$9 = 2;
			r = _tmp$8;
			size = _tmp$9;
			return [r, size];
		}
		s2 = s.charCodeAt(2);
		if (s2 < 128 || 191 < s2) {
			_tmp$10 = 65533;
			_tmp$11 = 1;
			r = _tmp$10;
			size = _tmp$11;
			return [r, size];
		}
		if (sz <= 3) {
			_tmp$12 = ((((((s0 & 15) >>> 0) >> 0)) << 12 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s2 & 63) >>> 0) >> 0));
			_tmp$13 = 3;
			r = _tmp$12;
			size = _tmp$13;
			return [r, size];
		}
		s3 = s.charCodeAt(3);
		if (s3 < 128 || 191 < s3) {
			_tmp$14 = 65533;
			_tmp$15 = 1;
			r = _tmp$14;
			size = _tmp$15;
			return [r, size];
		}
		_tmp$16 = (((((((s0 & 7) >>> 0) >> 0)) << 18 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 12 >> 0)) | (((((s2 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s3 & 63) >>> 0) >> 0));
		_tmp$17 = 4;
		r = _tmp$16;
		size = _tmp$17;
		return [r, size];
	};
	$pkg.DecodeRuneInString = DecodeRuneInString;
	EncodeRune = function(p, r) {
		var i, p, r;
		i = ((r >>> 0));
		if (i <= 127) {
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((r << 24 >>> 24)));
			return 1;
		} else if (i <= 2047) {
			$unused((1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((192 | (((r >> 6 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 2;
		} else if ((i > 1114111) || (55296 <= i && i <= 57343)) {
			r = 65533;
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else if (i <= 65535) {
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else {
			$unused((3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((240 | (((r >> 18 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 12 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 4;
		}
	};
	$pkg.EncodeRune = EncodeRune;
	ValidRune = function(r) {
		var r;
		if (0 <= r && r < 55296) {
			return true;
		} else if (57343 < r && r <= 1114111) {
			return true;
		}
		return false;
	};
	$pkg.ValidRune = ValidRune;
	acceptRange.init("unicode/utf8", [{prop: "lo", name: "lo", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "hi", name: "hi", embedded: false, exported: false, typ: $Uint8, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		first = $toNativeArray($kindUint8, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 19, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 35, 3, 3, 52, 4, 4, 4, 68, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241]);
		acceptRanges = $toNativeArray($kindStruct, [$clone(new acceptRange.ptr(128, 191), acceptRange), $clone(new acceptRange.ptr(160, 191), acceptRange), $clone(new acceptRange.ptr(128, 159), acceptRange), $clone(new acceptRange.ptr(144, 191), acceptRange), $clone(new acceptRange.ptr(128, 143), acceptRange), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0)]);
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["strconv"] = (function() {
	var $pkg = {}, $init, errors, js, bytealg, math, bits, utf8, NumError, sliceType, sliceType$1, sliceType$6, arrayType$1, ptrType$1, isPrint16, isNotPrint16, isPrint32, isNotPrint32, isGraphic, quoteWith, appendQuotedWith, appendEscapedRune, Quote, bsearch16, bsearch32, IsPrint, isInGraphicList, syntaxError, rangeError, Itoa, Atoi;
	errors = $packages["errors"];
	js = $packages["github.com/gopherjs/gopherjs/js"];
	bytealg = $packages["internal/bytealg"];
	math = $packages["math"];
	bits = $packages["math/bits"];
	utf8 = $packages["unicode/utf8"];
	NumError = $pkg.NumError = $newType(0, $kindStruct, "strconv.NumError", true, "strconv", true, function(Func_, Num_, Err_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Func = "";
			this.Num = "";
			this.Err = $ifaceNil;
			return;
		}
		this.Func = Func_;
		this.Num = Num_;
		this.Err = Err_;
	});
	sliceType = $sliceType($Uint16);
	sliceType$1 = $sliceType($Uint32);
	sliceType$6 = $sliceType($Uint8);
	arrayType$1 = $arrayType($Uint8, 4);
	ptrType$1 = $ptrType(NumError);
	quoteWith = function(s, quote, ASCIIonly, graphicOnly) {
		var ASCIIonly, _q, graphicOnly, quote, s;
		return ($bytesToString(appendQuotedWith($makeSlice(sliceType$6, 0, (_q = ($imul(3, s.length)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"))), s, quote, ASCIIonly, graphicOnly)));
	};
	appendQuotedWith = function(buf, s, quote, ASCIIonly, graphicOnly) {
		var ASCIIonly, _tuple, buf, graphicOnly, nBuf, quote, r, s, width;
		if ((buf.$capacity - buf.$length >> 0) < s.length) {
			nBuf = $makeSlice(sliceType$6, buf.$length, (((buf.$length + 1 >> 0) + s.length >> 0) + 1 >> 0));
			$copySlice(nBuf, buf);
			buf = nBuf;
		}
		buf = $append(buf, quote);
		width = 0;
		while (true) {
			if (!(s.length > 0)) { break; }
			r = ((s.charCodeAt(0) >> 0));
			width = 1;
			if (r >= 128) {
				_tuple = utf8.DecodeRuneInString(s);
				r = _tuple[0];
				width = _tuple[1];
			}
			if ((width === 1) && (r === 65533)) {
				buf = $appendSlice(buf, "\\x");
				buf = $append(buf, "0123456789abcdef".charCodeAt((s.charCodeAt(0) >>> 4 << 24 >>> 24)));
				buf = $append(buf, "0123456789abcdef".charCodeAt(((s.charCodeAt(0) & 15) >>> 0)));
				s = $substring(s, width);
				continue;
			}
			buf = appendEscapedRune(buf, r, quote, ASCIIonly, graphicOnly);
			s = $substring(s, width);
		}
		buf = $append(buf, quote);
		return buf;
	};
	appendEscapedRune = function(buf, r, quote, ASCIIonly, graphicOnly) {
		var ASCIIonly, _1, buf, graphicOnly, n, quote, r, runeTmp, s, s$1;
		runeTmp = arrayType$1.zero();
		if ((r === ((quote >> 0))) || (r === 92)) {
			buf = $append(buf, 92);
			buf = $append(buf, ((r << 24 >>> 24)));
			return buf;
		}
		if (ASCIIonly) {
			if (r < 128 && IsPrint(r)) {
				buf = $append(buf, ((r << 24 >>> 24)));
				return buf;
			}
		} else if (IsPrint(r) || graphicOnly && isInGraphicList(r)) {
			n = utf8.EncodeRune(new sliceType$6(runeTmp), r);
			buf = $appendSlice(buf, $subslice(new sliceType$6(runeTmp), 0, n));
			return buf;
		}
		_1 = r;
		if (_1 === (7)) {
			buf = $appendSlice(buf, "\\a");
		} else if (_1 === (8)) {
			buf = $appendSlice(buf, "\\b");
		} else if (_1 === (12)) {
			buf = $appendSlice(buf, "\\f");
		} else if (_1 === (10)) {
			buf = $appendSlice(buf, "\\n");
		} else if (_1 === (13)) {
			buf = $appendSlice(buf, "\\r");
		} else if (_1 === (9)) {
			buf = $appendSlice(buf, "\\t");
		} else if (_1 === (11)) {
			buf = $appendSlice(buf, "\\v");
		} else {
			if (r < 32 || (r === 127)) {
				buf = $appendSlice(buf, "\\x");
				buf = $append(buf, "0123456789abcdef".charCodeAt((((r << 24 >>> 24)) >>> 4 << 24 >>> 24)));
				buf = $append(buf, "0123456789abcdef".charCodeAt(((((r << 24 >>> 24)) & 15) >>> 0)));
			} else if (!utf8.ValidRune(r)) {
				r = 65533;
				buf = $appendSlice(buf, "\\u");
				s = 12;
				while (true) {
					if (!(s >= 0)) { break; }
					buf = $append(buf, "0123456789abcdef".charCodeAt((((r >> $min(((s >>> 0)), 31)) >> 0) & 15)));
					s = s - (4) >> 0;
				}
			} else if (r < 65536) {
				buf = $appendSlice(buf, "\\u");
				s = 12;
				while (true) {
					if (!(s >= 0)) { break; }
					buf = $append(buf, "0123456789abcdef".charCodeAt((((r >> $min(((s >>> 0)), 31)) >> 0) & 15)));
					s = s - (4) >> 0;
				}
			} else {
				buf = $appendSlice(buf, "\\U");
				s$1 = 28;
				while (true) {
					if (!(s$1 >= 0)) { break; }
					buf = $append(buf, "0123456789abcdef".charCodeAt((((r >> $min(((s$1 >>> 0)), 31)) >> 0) & 15)));
					s$1 = s$1 - (4) >> 0;
				}
			}
		}
		return buf;
	};
	Quote = function(s) {
		var s;
		return quoteWith(s, 34, false, false);
	};
	$pkg.Quote = Quote;
	bsearch16 = function(a, x) {
		var _tmp, _tmp$1, a, h, i, j, x;
		_tmp = 0;
		_tmp$1 = a.$length;
		i = _tmp;
		j = _tmp$1;
		while (true) {
			if (!(i < j)) { break; }
			h = i + (((j - i >> 0)) >> 1 >> 0) >> 0;
			if (((h < 0 || h >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + h]) < x) {
				i = h + 1 >> 0;
			} else {
				j = h;
			}
		}
		return i;
	};
	bsearch32 = function(a, x) {
		var _tmp, _tmp$1, a, h, i, j, x;
		_tmp = 0;
		_tmp$1 = a.$length;
		i = _tmp;
		j = _tmp$1;
		while (true) {
			if (!(i < j)) { break; }
			h = i + (((j - i >> 0)) >> 1 >> 0) >> 0;
			if (((h < 0 || h >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + h]) < x) {
				i = h + 1 >> 0;
			} else {
				j = h;
			}
		}
		return i;
	};
	IsPrint = function(r) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, i, i$1, isNotPrint, isNotPrint$1, isPrint, isPrint$1, j, j$1, r, rr, rr$1, x, x$1, x$2, x$3;
		if (r <= 255) {
			if (32 <= r && r <= 126) {
				return true;
			}
			if (161 <= r && r <= 255) {
				return !((r === 173));
			}
			return false;
		}
		if (0 <= r && r < 65536) {
			_tmp = ((r << 16 >>> 16));
			_tmp$1 = isPrint16;
			_tmp$2 = isNotPrint16;
			rr = _tmp;
			isPrint = _tmp$1;
			isNotPrint = _tmp$2;
			i = bsearch16(isPrint, rr);
			if (i >= isPrint.$length || rr < (x = (i & ~1) >> 0, ((x < 0 || x >= isPrint.$length) ? ($throwRuntimeError("index out of range"), undefined) : isPrint.$array[isPrint.$offset + x])) || (x$1 = i | 1, ((x$1 < 0 || x$1 >= isPrint.$length) ? ($throwRuntimeError("index out of range"), undefined) : isPrint.$array[isPrint.$offset + x$1])) < rr) {
				return false;
			}
			j = bsearch16(isNotPrint, rr);
			return j >= isNotPrint.$length || !((((j < 0 || j >= isNotPrint.$length) ? ($throwRuntimeError("index out of range"), undefined) : isNotPrint.$array[isNotPrint.$offset + j]) === rr));
		}
		_tmp$3 = ((r >>> 0));
		_tmp$4 = isPrint32;
		_tmp$5 = isNotPrint32;
		rr$1 = _tmp$3;
		isPrint$1 = _tmp$4;
		isNotPrint$1 = _tmp$5;
		i$1 = bsearch32(isPrint$1, rr$1);
		if (i$1 >= isPrint$1.$length || rr$1 < (x$2 = (i$1 & ~1) >> 0, ((x$2 < 0 || x$2 >= isPrint$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : isPrint$1.$array[isPrint$1.$offset + x$2])) || (x$3 = i$1 | 1, ((x$3 < 0 || x$3 >= isPrint$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : isPrint$1.$array[isPrint$1.$offset + x$3])) < rr$1) {
			return false;
		}
		if (r >= 131072) {
			return true;
		}
		r = r - (65536) >> 0;
		j$1 = bsearch16(isNotPrint$1, ((r << 16 >>> 16)));
		return j$1 >= isNotPrint$1.$length || !((((j$1 < 0 || j$1 >= isNotPrint$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : isNotPrint$1.$array[isNotPrint$1.$offset + j$1]) === ((r << 16 >>> 16))));
	};
	$pkg.IsPrint = IsPrint;
	isInGraphicList = function(r) {
		var i, r, rr;
		if (r > 65535) {
			return false;
		}
		rr = ((r << 16 >>> 16));
		i = bsearch16(isGraphic, rr);
		return i < isGraphic.$length && (rr === ((i < 0 || i >= isGraphic.$length) ? ($throwRuntimeError("index out of range"), undefined) : isGraphic.$array[isGraphic.$offset + i]));
	};
	NumError.ptr.prototype.Error = function() {
		var {$24r, _r, e, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		e = this;
		_r = e.Err.Error(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = "strconv." + e.Func + ": " + "parsing " + Quote(e.Num) + ": " + _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: NumError.ptr.prototype.Error, $c: true, $r, $24r, _r, e, $s};return $f;
	};
	NumError.prototype.Error = function() { return this.$val.Error(); };
	NumError.ptr.prototype.Unwrap = function() {
		var e;
		e = this;
		return e.Err;
	};
	NumError.prototype.Unwrap = function() { return this.$val.Unwrap(); };
	syntaxError = function(fn, str) {
		var fn, str;
		return new NumError.ptr(fn, str, $pkg.ErrSyntax);
	};
	rangeError = function(fn, str) {
		var fn, str;
		return new NumError.ptr(fn, str, $pkg.ErrRange);
	};
	Itoa = function(i) {
		var i;
		return $internalize(i.toString(), $String);
	};
	$pkg.Itoa = Itoa;
	Atoi = function(s) {
		var floatval, i, jsValue, s, v;
		if (s.length === 0) {
			return [0, syntaxError("Atoi", s)];
		}
		i = 0;
		while (true) {
			if (!(i < s.length)) { break; }
			v = s.charCodeAt(i);
			if (v < 48 || v > 57) {
				if (!((v === 43)) && !((v === 45))) {
					return [0, syntaxError("Atoi", s)];
				}
			}
			i = i + (1) >> 0;
		}
		jsValue = $global.Number($externalize(s, $String), 10);
		if (!!!($global.isFinite(jsValue))) {
			return [0, syntaxError("Atoi", s)];
		}
		floatval = $parseFloat(jsValue);
		if (floatval > 2.147483647e+09) {
			return [2147483647, rangeError("Atoi", s)];
		} else if (floatval < -2.147483648e+09) {
			return [-2147483648, rangeError("Atoi", s)];
		}
		return [$parseInt(jsValue) >> 0, $ifaceNil];
	};
	$pkg.Atoi = Atoi;
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Unwrap", name: "Unwrap", pkg: "", typ: $funcType([], [$error], false)}];
	NumError.init("", [{prop: "Func", name: "Func", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Num", name: "Num", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Err", name: "Err", embedded: false, exported: true, typ: $error, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = errors.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = js.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bytealg.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = math.$init(); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = utf8.$init(); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		isPrint16 = new sliceType([32, 126, 161, 887, 890, 895, 900, 1366, 1369, 1418, 1421, 1479, 1488, 1514, 1519, 1524, 1542, 1563, 1566, 1805, 1808, 1866, 1869, 1969, 1984, 2042, 2045, 2093, 2096, 2139, 2142, 2154, 2208, 2247, 2259, 2444, 2447, 2448, 2451, 2482, 2486, 2489, 2492, 2500, 2503, 2504, 2507, 2510, 2519, 2519, 2524, 2531, 2534, 2558, 2561, 2570, 2575, 2576, 2579, 2617, 2620, 2626, 2631, 2632, 2635, 2637, 2641, 2641, 2649, 2654, 2662, 2678, 2689, 2745, 2748, 2765, 2768, 2768, 2784, 2787, 2790, 2801, 2809, 2828, 2831, 2832, 2835, 2873, 2876, 2884, 2887, 2888, 2891, 2893, 2901, 2903, 2908, 2915, 2918, 2935, 2946, 2954, 2958, 2965, 2969, 2975, 2979, 2980, 2984, 2986, 2990, 3001, 3006, 3010, 3014, 3021, 3024, 3024, 3031, 3031, 3046, 3066, 3072, 3129, 3133, 3149, 3157, 3162, 3168, 3171, 3174, 3183, 3191, 3257, 3260, 3277, 3285, 3286, 3294, 3299, 3302, 3314, 3328, 3407, 3412, 3427, 3430, 3478, 3482, 3517, 3520, 3526, 3530, 3530, 3535, 3551, 3558, 3567, 3570, 3572, 3585, 3642, 3647, 3675, 3713, 3773, 3776, 3789, 3792, 3801, 3804, 3807, 3840, 3948, 3953, 4058, 4096, 4295, 4301, 4301, 4304, 4685, 4688, 4701, 4704, 4749, 4752, 4789, 4792, 4805, 4808, 4885, 4888, 4954, 4957, 4988, 4992, 5017, 5024, 5109, 5112, 5117, 5120, 5788, 5792, 5880, 5888, 5908, 5920, 5942, 5952, 5971, 5984, 6003, 6016, 6109, 6112, 6121, 6128, 6137, 6144, 6157, 6160, 6169, 6176, 6264, 6272, 6314, 6320, 6389, 6400, 6443, 6448, 6459, 6464, 6464, 6468, 6509, 6512, 6516, 6528, 6571, 6576, 6601, 6608, 6618, 6622, 6683, 6686, 6780, 6783, 6793, 6800, 6809, 6816, 6829, 6832, 6848, 6912, 6987, 6992, 7036, 7040, 7155, 7164, 7223, 7227, 7241, 7245, 7304, 7312, 7354, 7357, 7367, 7376, 7418, 7424, 7957, 7960, 7965, 7968, 8005, 8008, 8013, 8016, 8061, 8064, 8147, 8150, 8175, 8178, 8190, 8208, 8231, 8240, 8286, 8304, 8305, 8308, 8348, 8352, 8383, 8400, 8432, 8448, 8587, 8592, 9254, 9280, 9290, 9312, 11123, 11126, 11507, 11513, 11559, 11565, 11565, 11568, 11623, 11631, 11632, 11647, 11670, 11680, 11858, 11904, 12019, 12032, 12245, 12272, 12283, 12289, 12438, 12441, 12543, 12549, 12771, 12784, 40956, 40960, 42124, 42128, 42182, 42192, 42539, 42560, 42743, 42752, 42943, 42946, 42954, 42997, 43052, 43056, 43065, 43072, 43127, 43136, 43205, 43214, 43225, 43232, 43347, 43359, 43388, 43392, 43481, 43486, 43574, 43584, 43597, 43600, 43609, 43612, 43714, 43739, 43766, 43777, 43782, 43785, 43790, 43793, 43798, 43808, 43883, 43888, 44013, 44016, 44025, 44032, 55203, 55216, 55238, 55243, 55291, 63744, 64109, 64112, 64217, 64256, 64262, 64275, 64279, 64285, 64449, 64467, 64831, 64848, 64911, 64914, 64967, 65008, 65021, 65024, 65049, 65056, 65131, 65136, 65276, 65281, 65470, 65474, 65479, 65482, 65487, 65490, 65495, 65498, 65500, 65504, 65518, 65532, 65533]);
		isNotPrint16 = new sliceType([173, 907, 909, 930, 1328, 1424, 1757, 2111, 2143, 2229, 2274, 2436, 2473, 2481, 2526, 2564, 2601, 2609, 2612, 2615, 2621, 2653, 2692, 2702, 2706, 2729, 2737, 2740, 2758, 2762, 2816, 2820, 2857, 2865, 2868, 2910, 2948, 2961, 2971, 2973, 3017, 3085, 3089, 3113, 3141, 3145, 3159, 3213, 3217, 3241, 3252, 3269, 3273, 3295, 3312, 3341, 3345, 3397, 3401, 3456, 3460, 3506, 3516, 3541, 3543, 3715, 3717, 3723, 3748, 3750, 3781, 3783, 3912, 3992, 4029, 4045, 4294, 4681, 4695, 4697, 4745, 4785, 4799, 4801, 4823, 4881, 5760, 5901, 5997, 6001, 6431, 6751, 7674, 8024, 8026, 8028, 8030, 8117, 8133, 8156, 8181, 8335, 11158, 11311, 11359, 11558, 11687, 11695, 11703, 11711, 11719, 11727, 11735, 11743, 11930, 12352, 12592, 12687, 12831, 43470, 43519, 43815, 43823, 64311, 64317, 64319, 64322, 64325, 65107, 65127, 65141, 65511]);
		isPrint32 = new sliceType$1([65536, 65613, 65616, 65629, 65664, 65786, 65792, 65794, 65799, 65843, 65847, 65948, 65952, 65952, 66000, 66045, 66176, 66204, 66208, 66256, 66272, 66299, 66304, 66339, 66349, 66378, 66384, 66426, 66432, 66499, 66504, 66517, 66560, 66717, 66720, 66729, 66736, 66771, 66776, 66811, 66816, 66855, 66864, 66915, 66927, 66927, 67072, 67382, 67392, 67413, 67424, 67431, 67584, 67589, 67592, 67640, 67644, 67644, 67647, 67742, 67751, 67759, 67808, 67829, 67835, 67867, 67871, 67897, 67903, 67903, 67968, 68023, 68028, 68047, 68050, 68102, 68108, 68149, 68152, 68154, 68159, 68168, 68176, 68184, 68192, 68255, 68288, 68326, 68331, 68342, 68352, 68405, 68409, 68437, 68440, 68466, 68472, 68497, 68505, 68508, 68521, 68527, 68608, 68680, 68736, 68786, 68800, 68850, 68858, 68903, 68912, 68921, 69216, 69293, 69296, 69297, 69376, 69415, 69424, 69465, 69552, 69579, 69600, 69622, 69632, 69709, 69714, 69743, 69759, 69825, 69840, 69864, 69872, 69881, 69888, 69959, 69968, 70006, 70016, 70132, 70144, 70206, 70272, 70313, 70320, 70378, 70384, 70393, 70400, 70412, 70415, 70416, 70419, 70468, 70471, 70472, 70475, 70477, 70480, 70480, 70487, 70487, 70493, 70499, 70502, 70508, 70512, 70516, 70656, 70753, 70784, 70855, 70864, 70873, 71040, 71093, 71096, 71133, 71168, 71236, 71248, 71257, 71264, 71276, 71296, 71352, 71360, 71369, 71424, 71450, 71453, 71467, 71472, 71487, 71680, 71739, 71840, 71922, 71935, 71942, 71945, 71945, 71948, 71992, 71995, 72006, 72016, 72025, 72096, 72103, 72106, 72151, 72154, 72164, 72192, 72263, 72272, 72354, 72384, 72440, 72704, 72773, 72784, 72812, 72816, 72847, 72850, 72886, 72960, 73014, 73018, 73031, 73040, 73049, 73056, 73112, 73120, 73129, 73440, 73464, 73648, 73648, 73664, 73713, 73727, 74649, 74752, 74868, 74880, 75075, 77824, 78894, 82944, 83526, 92160, 92728, 92736, 92777, 92782, 92783, 92880, 92909, 92912, 92917, 92928, 92997, 93008, 93047, 93053, 93071, 93760, 93850, 93952, 94026, 94031, 94087, 94095, 94111, 94176, 94180, 94192, 94193, 94208, 100343, 100352, 101589, 101632, 101640, 110592, 110878, 110928, 110930, 110948, 110951, 110960, 111355, 113664, 113770, 113776, 113788, 113792, 113800, 113808, 113817, 113820, 113823, 118784, 119029, 119040, 119078, 119081, 119154, 119163, 119272, 119296, 119365, 119520, 119539, 119552, 119638, 119648, 119672, 119808, 119967, 119970, 119970, 119973, 119974, 119977, 120074, 120077, 120134, 120138, 120485, 120488, 120779, 120782, 121483, 121499, 121519, 122880, 122904, 122907, 122922, 123136, 123180, 123184, 123197, 123200, 123209, 123214, 123215, 123584, 123641, 123647, 123647, 124928, 125124, 125127, 125142, 125184, 125259, 125264, 125273, 125278, 125279, 126065, 126132, 126209, 126269, 126464, 126500, 126503, 126523, 126530, 126530, 126535, 126548, 126551, 126564, 126567, 126619, 126625, 126651, 126704, 126705, 126976, 127019, 127024, 127123, 127136, 127150, 127153, 127221, 127232, 127405, 127462, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 128727, 128736, 128748, 128752, 128764, 128768, 128883, 128896, 128984, 128992, 129003, 129024, 129035, 129040, 129095, 129104, 129113, 129120, 129159, 129168, 129197, 129200, 129201, 129280, 129619, 129632, 129645, 129648, 129652, 129656, 129658, 129664, 129670, 129680, 129704, 129712, 129718, 129728, 129730, 129744, 129750, 129792, 129994, 130032, 130041, 131072, 173789, 173824, 177972, 177984, 178205, 178208, 183969, 183984, 191456, 194560, 195101, 196608, 201546, 917760, 917999]);
		isNotPrint32 = new sliceType([12, 39, 59, 62, 399, 926, 2057, 2102, 2134, 2291, 2564, 2580, 2584, 3711, 3754, 4285, 4405, 4576, 4626, 4743, 4745, 4750, 4766, 4868, 4905, 4913, 4916, 4922, 5212, 6420, 6423, 6454, 7177, 7223, 7336, 7431, 7434, 7483, 7486, 7526, 7529, 7567, 7570, 9327, 27231, 27482, 27490, 54357, 54429, 54445, 54458, 54460, 54468, 54534, 54549, 54557, 54586, 54591, 54597, 54609, 55968, 57351, 57378, 57381, 60932, 60960, 60963, 60968, 60979, 60984, 60986, 61000, 61002, 61004, 61008, 61011, 61016, 61018, 61020, 61022, 61024, 61027, 61035, 61043, 61048, 61053, 61055, 61066, 61092, 61098, 61632, 61648, 63865, 63948, 64403]);
		isGraphic = new sliceType([160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8239, 8287, 12288]);
		$pkg.ErrRange = errors.New("value out of range");
		$pkg.ErrSyntax = errors.New("invalid syntax");
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["go-extension"] = (function() {
	var $pkg = {}, $init, js, strconv, funcType, timerID, originalMins, remainingSecs, isPaused, isRunning, formatTime, pad, updateDisplay, stopTimer, recoverOriginalTime, startTimer, main;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	strconv = $packages["strconv"];
	funcType = $funcType([], [], false);
	formatTime = function(seconds) {
		var _q, _r, min, sec, seconds;
		min = (_q = seconds / 60, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"));
		sec = (_r = seconds % 60, _r === _r ? _r : $throwRuntimeError("integer divide by zero"));
		return pad(min) + ":" + pad(sec);
	};
	pad = function(n) {
		var n;
		if (n < 10) {
			return "0" + strconv.Itoa(n);
		}
		return strconv.Itoa(n);
	};
	updateDisplay = function() {
		$global.document.getElementById($externalize("title", $String)).innerText = $externalize(formatTime(remainingSecs), $String);
	};
	stopTimer = function() {
		if (!(timerID === null)) {
			$global.clearInterval(timerID);
			timerID = null;
			isPaused = true;
			isRunning = false;
		}
	};
	recoverOriginalTime = function() {
		if (originalMins > 0) {
			stopTimer();
			remainingSecs = $imul(originalMins, 60);
			updateDisplay();
		}
	};
	startTimer = function() {
		if (isRunning || remainingSecs <= 0) {
			return;
		}
		timerID = $global.setInterval($externalize((function() {
			if (remainingSecs > 0) {
				remainingSecs = remainingSecs - (1) >> 0;
				updateDisplay();
			} else {
				stopTimer();
			}
		}), funcType), 1000);
		isPaused = false;
		isRunning = true;
	};
	main = function() {
		var doc, title;
		updateDisplay();
		doc = $global.document;
		title = doc.getElementById($externalize("title", $String));
		title.addEventListener($externalize("click", $String), $externalize((function() {
			var _tuple, err, input, mins;
			input = $global.prompt($externalize("\xD0\x92\xD0\xB2\xD0\xB5\xD0\xB4\xD0\xB8\xD1\x82\xD0\xB5 \xD0\xBA\xD0\xBE\xD0\xBB\xD0\xB8\xD1\x87\xD0\xB5\xD1\x81\xD1\x82\xD0\xB2\xD0\xBE \xD0\xBC\xD0\xB8\xD0\xBD\xD1\x83\xD1\x82", $String), $externalize("25", $String));
			_tuple = strconv.Atoi($internalize(input, $String));
			mins = _tuple[0];
			err = _tuple[1];
			if ($interfaceIsEqual(err, $ifaceNil) && mins > 0) {
				originalMins = mins;
				remainingSecs = $imul(mins, 60);
				updateDisplay();
			}
		}), funcType));
		doc.getElementById($externalize("startBtn", $String)).addEventListener($externalize("click", $String), $externalize((function() {
			startTimer();
		}), funcType));
		doc.getElementById($externalize("stopBtn", $String)).addEventListener($externalize("click", $String), $externalize((function() {
			stopTimer();
		}), funcType));
		doc.getElementById($externalize("recoverBtn", $String)).addEventListener($externalize("click", $String), $externalize((function() {
			recoverOriginalTime();
		}), funcType));
	};
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = strconv.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		timerID = null;
		originalMins = 0;
		remainingSecs = 0;
		isPaused = false;
		isRunning = false;
		if ($pkg === $mainPkg) {
			main();
			$mainFinished = true;
		}
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$synthesizeMethods();
$initAllLinknames();
var $mainPkg = $packages["go-extension"];
$packages["runtime"].$init();
$go($mainPkg.$init, []);
$flushConsole();

}).call(this);
//# sourceMappingURL=main.js.map
