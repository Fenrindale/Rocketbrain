package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.util.*;

import static rocketbrain.signature.SignatureInspector.object;

final class PackageRenameInspector {
    private final Trees trees;
    private final SourcePositions positions;
    private final Elements elements;
    private final Types types;
    private final String prefix;
    private final String other;
    private int bindingCount;
    private final boolean qualifiedModules;
    private final boolean serviceModules;
    private Set<String> ownedModules = Set.of();

    PackageRenameInspector(JavacTask task, String prefix, String other) {
        this(task,prefix,other,false,false);
    }

    PackageRenameInspector(JavacTask task, String prefix, String other, boolean qualifiedModules, boolean serviceModules) {
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
        this.elements = task.getElements();
        this.types = task.getTypes();
        this.prefix = prefix;
        this.other = other;
        this.qualifiedModules = qualifiedModules;
        this.serviceModules = serviceModules;
    }

    List<Map<String, Object>> inspect(List<CompilationUnitTree> units) {
        if (qualifiedModules) {
            var names = new LinkedHashSet<String>();
            for (var unit : units) if (unit.getModule()!=null) names.add(unit.getModule().getName().toString());
            if (serviceModules ? names.size()<4 || names.size()>6 : names.size()!=2) throw unprovedDirective();
            ownedModules = Set.copyOf(names);
        }
        Set<String> localPackages = new HashSet<>();
        Set<String> sourceUris = new HashSet<>();
        for (var unit : units) {
            if (unit.getPackageName() != null) localPackages.add(unit.getPackageName().toString());
            sourceUris.add(unit.getSourceFile().toUri().toString());
        }
        return units.stream().map(unit -> inspectUnit(unit, localPackages, sourceUris)).toList();
    }

    private boolean inside(String packageName) {
        return packageName.equals(prefix) || packageName.startsWith(prefix + ".");
    }

    private Map<String, Object> inspectUnit(CompilationUnitTree unit, Set<String> localPackages, Set<String> sourceUris) {
        String packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
        var spans = new TreeMap<Integer, Map<String, Object>>();
        var bindings = new ArrayList<List<Object>>();
        var serviceReads = new ArrayList<Map<String,Object>>();
        String uri = unit.getSourceFile().toUri().toString();
        String text;
        try { text = unit.getSourceFile().getCharContent(true).toString(); }
        catch (java.io.IOException error) { throw new IllegalStateException("Cannot read the attributed package source.", error); }

        new TreePathScanner<Void,Void>() {
            int start(Tree node) { return (int) positions.getStartPosition(unit, node); }
            int end(Tree node) { return (int) positions.getEndPosition(unit, node); }

            void span(Tree node, String role) {
                Tree selected = node;
                while (selected instanceof MemberSelectTree member && !selected.toString().equals(prefix)) {
                    selected = member.getExpression();
                }
                if (!selected.toString().equals(prefix)) return;
                int from = start(selected), to = end(selected);
                if (from < 0 || to > text.length() || to - from != prefix.length() ||
                    !text.regionMatches(from, prefix, 0, prefix.length())) {
                    throw new IllegalArgumentException("Use ordinary exact Java package names without escapes or interleaved trivia.");
                }
                spans.putIfAbsent(from, object("start", from, "end", to, "role", role));
                if (spans.size() > 5000) throw new IllegalArgumentException("Java package reference review exceeds its span limit.");
            }

            void binding(Tree node, Element resolved) {
                int from = start(node), to = end(node);
                if (from < 0 || to <= from || resolved == null) return;
                List<String> identity;
                if (resolved instanceof TypeElement type) {
                    identity = List.of("type", elements.getBinaryName(type).toString());
                } else if (resolved instanceof ExecutableElement member && member.getEnclosingElement() instanceof TypeElement owner) {
                    identity = new ArrayList<>(List.of("method", elements.getBinaryName(owner).toString(),
                        member.getSimpleName().toString(), types.erasure(member.getReturnType()).toString()));
                    for (var parameter : member.getParameters()) identity.add(types.erasure(parameter.asType()).toString());
                } else if (resolved instanceof VariableElement member &&
                    (member.getKind() == ElementKind.FIELD || member.getKind() == ElementKind.ENUM_CONSTANT) &&
                    member.getEnclosingElement() instanceof TypeElement owner) {
                    identity = List.of("field", elements.getBinaryName(owner).toString(), member.getSimpleName().toString(),
                        types.erasure(member.asType()).toString());
                } else return;
                if (++bindingCount > 24000) throw new IllegalArgumentException("Java package binding review exceeds its limit.");
                if (qualifiedModules) {
                    ModuleElement module = elements.getModuleOf(resolved);
                    if (module==null || module.isUnnamed()) throw unprovedDirective();
                    bindings.add(List.of(from,to,node.getKind().name(),identity,module.getQualifiedName().toString()));
                } else bindings.add(List.of(from,to,node.getKind().name(),identity));
            }

            @Override public Void visitCompilationUnit(CompilationUnitTree node, Void unused) {
                if (inside(packageName)) span(node.getPackageName(), "declaration");
                return super.visitCompilationUnit(node, unused);
            }

            @Override public Void visitImport(ImportTree node, Void unused) {
                Tree imported = node.getQualifiedIdentifier();
                if (imported instanceof MemberSelectTree member && (member.getIdentifier().contentEquals("*") || node.isStatic())) {
                    imported = member.getExpression();
                }
                String qualified = imported.toString();
                TypeElement type = elements.getTypeElement(qualified);
                PackageElement owner = type == null ? elements.getPackageElement(qualified) : elements.getPackageOf(type);
                if (owner != null && inside(owner.getQualifiedName().toString())) span(imported, "reference");
                return super.visitImport(node, unused);
            }

            @Override public Void visitVariable(VariableTree node, Void unused) {
                Tree type = node.getType();
                if (type != null && end(type) < 0) {
                    // Attribution can populate invisible types for inferred lambda parameters and var.
                    // Their bindings are checked at the real uses, where the editor has source spans.
                    scan(node.getModifiers(), unused);
                    scan(node.getNameExpression(), unused);
                    return scan(node.getInitializer(), unused);
                }
                return super.visitVariable(node, unused);
            }

            @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                Element resolved = trees.getElement(getCurrentPath());
                if (resolved instanceof PackageElement pkg && inside(pkg.getQualifiedName().toString())) span(node, "reference");
                binding(node, resolved);
                return super.visitIdentifier(node, unused);
            }

            @Override public Void visitMemberSelect(MemberSelectTree node, Void unused) {
                Element resolved = trees.getElement(getCurrentPath());
                if (resolved instanceof PackageElement pkg && inside(pkg.getQualifiedName().toString()) ||
                    resolved instanceof TypeElement type && type.getQualifiedName().contentEquals(node.toString()) &&
                    inside(elements.getPackageOf(type).getQualifiedName().toString())) span(node, "reference");
                binding(node, resolved);
                return super.visitMemberSelect(node, unused);
            }

            @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                Element resolved = trees.getElement(getCurrentPath());
                binding(node, resolved);
                if (serviceModules && resolved instanceof ExecutableElement method &&
                        method.getEnclosingElement() instanceof TypeElement owner &&
                        owner.getQualifiedName().contentEquals("java.util.ServiceLoader") &&
                        elements.getModuleOf(owner).getQualifiedName().contentEquals("java.base") &&
                        method.getSimpleName().contentEquals("load") && node.getArguments().size()==2 &&
                        types.erasure(method.getParameters().getFirst().asType()).toString().equals("java.lang.ModuleLayer") &&
                        node.getArguments().get(1) instanceof MemberSelectTree literal &&
                        literal.getIdentifier().contentEquals("class")) {
                    var symbol = trees.getElement(TreePath.getPath(unit,literal.getExpression()));
                    if (symbol instanceof TypeElement service && ownedModules.contains(elements.getModuleOf(service).getQualifiedName().toString())) {
                        serviceReads.add(object("end",end(node),"service",service.getQualifiedName().toString(),
                            "owner",elements.getModuleOf(service).getQualifiedName().toString()));
                    }
                }
                return super.visitMethodInvocation(node, unused);
            }

            @Override public Void visitNewClass(NewClassTree node, Void unused) {
                binding(node, trees.getElement(getCurrentPath()));
                return super.visitNewClass(node, unused);
            }

            @Override public Void visitMemberReference(MemberReferenceTree node, Void unused) {
                binding(node, trees.getElement(getCurrentPath()));
                return super.visitMemberReference(node, unused);
            }
        }.scan(unit, null);
        boolean opposingNamespace = packageName.equals(other) || packageName.startsWith(other + ".");
        var module = unit.getModule() == null ? null : moduleProof(unit, localPackages, sourceUris);
        if (serviceModules && module != null) addServiceDirectiveSpans(module, spans, text);
        var result = object("uri", uri, "name", packageName, "competingNamespace", opposingNamespace,
            "spans", spans.values().stream().toList(), "bindings", bindings);
        if (module != null) result.put("module", module);
        if (serviceModules) result.put("serviceReads",serviceReads);
        return result;
    }

    private void addServiceDirectiveSpans(Map<String, Object> module,
            Map<Integer,Map<String,Object>> spans, String text) {
        for (var directive : (List<?>) module.get("declarations")) {
            if (!(directive instanceof Map<?,?> entry) ||
                    !Set.of("uses","provides","with").contains(entry.get("role")) ||
                    !inside((String) entry.get("name"))) continue;
            int start = ((Number) entry.get("start")).intValue();
            int end = start + prefix.length();
            if (end > text.length() || !text.regionMatches(start,prefix,0,prefix.length())) throw unprovedDirective();
            spans.putIfAbsent(start,object("start",start,"end",end,"role","reference"));
        }
    }

    private Map<String, Object> moduleProof(CompilationUnitTree unit, Set<String> localPackages, Set<String> sourceUris) {
        ModuleTree tree = unit.getModule();
        String moduleName = tree.getName().toString();
        ModuleElement module = elements.getModuleElement(moduleName);
        if (module == null || module.isOpen() || module.isUnnamed() || !module.getQualifiedName().contentEquals(moduleName)) {
            throw new IllegalArgumentException("Javac could not prove the selected closed source module.");
        }
        var entries = new ArrayList<Map<String, Object>>();
        for (var directive : tree.getDirectives()) {
            switch (directive) {
                case RequiresTree requirement -> {
                    ExpressionTree source = requirement.getModuleName();
                    ModuleElement dependency = elements.getModuleElement(source.toString());
                    if (requirement.isStatic() || requirement.isTransitive() || dependency == null ||
                            (!dependency.getQualifiedName().contentEquals("java.base") &&
                            !ownedModules.contains(dependency.getQualifiedName().toString()))) throw unprovedDirective();
                    entries.add(moduleEntry(unit, source, "requires"));
                }
                case ExportsTree exported -> {
                    entries.add(packageDirective(unit, module, exported.getPackageName(), "exports", localPackages));
                    addTargets(unit,module,exported.getModuleNames(),"exportsTo",entries);
                }
                case OpensTree opened -> {
                    entries.add(packageDirective(unit, module, opened.getPackageName(), "opens", localPackages));
                    addTargets(unit,module,opened.getModuleNames(),"opensTo",entries);
                }
                case UsesTree used -> entries.add(typeDirective(unit, module, used.getServiceName(), "uses", sourceUris));
                case ProvidesTree provides -> {
                    entries.add(typeDirective(unit, module, provides.getServiceName(), "provides", sourceUris));
                    for (var provider : provides.getImplementationNames()) {
                        entries.add(typeDirective(unit, module, provider, "with", sourceUris));
                    }
                }
                default -> throw unprovedDirective();
            }
        }
        return object("name", moduleName, "declarations", entries);
    }

    private void addTargets(CompilationUnitTree unit, ModuleElement owner, List<? extends ExpressionTree> targets,
            String role, List<Map<String,Object>> entries) {
        if (targets==null || targets.isEmpty()) return;
        if (!qualifiedModules || targets.size()!=1) throw unprovedDirective();
        var source=targets.getFirst();
        var target=elements.getModuleElement(source.toString());
        if (target==null || target.equals(owner) || !ownedModules.contains(target.getQualifiedName().toString()) ||
                !target.getQualifiedName().contentEquals(source.toString())) throw unprovedDirective();
        entries.add(moduleEntry(unit,source,role));
    }

    private Map<String, Object> packageDirective(CompilationUnitTree unit, ModuleElement module, ExpressionTree source,
            String role, Set<String> localPackages) {
        String name = source.toString();
        PackageElement resolved = elements.getPackageElement(module, name);
        if (!localPackages.contains(name) || resolved == null || !module.equals(elements.getModuleOf(resolved)) ||
                !resolved.getQualifiedName().contentEquals(name)) throw unprovedDirective();
        return moduleEntry(unit, source, role);
    }

    private Map<String, Object> typeDirective(CompilationUnitTree unit, ModuleElement module, ExpressionTree source,
            String role, Set<String> sourceUris) {
        String name = source.toString();
        Element attributed = serviceModules ? trees.getElement(TreePath.getPath(unit,source)) : elements.getTypeElement(module,name);
        if (!(attributed instanceof TypeElement resolved)) throw unprovedDirective();
        var declaration = trees.getPath(resolved);
        var owner = elements.getModuleOf(resolved);
        boolean owned = module.equals(owner) || serviceModules && !role.equals("with") &&
            owner != null && ownedModules.contains(owner.getQualifiedName().toString());
        if (declaration == null || !owned ||
                resolved.getNestingKind() != NestingKind.TOP_LEVEL || !resolved.getQualifiedName().contentEquals(name) ||
                !sourceUris.contains(declaration.getCompilationUnit().getSourceFile().toUri().toString())) throw unprovedDirective();
        var entry = moduleEntry(unit, source, role);
        if (serviceModules) entry.put("owner", owner.getQualifiedName().toString());
        return entry;
    }

    private Map<String, Object> moduleEntry(CompilationUnitTree unit, ExpressionTree source, String role) {
        long start = positions.getStartPosition(unit, source), end = positions.getEndPosition(unit, source);
        if (start < 0 || end <= start) throw unprovedDirective();
        return object("role", role, "name", source.toString(), "start", start, "end", end);
    }

    private IllegalArgumentException unprovedDirective() {
        return new IllegalArgumentException("Javac could not prove an exact owned source module directive.");
    }
}
