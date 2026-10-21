// OPTIONAL (M7), untested without a Navisworks licence. P6Clone4DRunner <package folder> [out.nwd]: starts Navisworks
// hidden, appends the package's *-4D.ifc, runs the P6Clone4D add-in on the folder, and saves the linked NWD.
using System;
using System.IO;
using System.Linq;
using Autodesk.Navisworks.Api.Automation;

class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: P6Clone4DRunner <package folder> [out.nwd]"); return 2; }
        var dir = Path.GetFullPath(args[0]);
        var ifc = Directory.GetFiles(dir, "*-4D.ifc").FirstOrDefault();
        if (ifc == null) { Console.Error.WriteLine("No *-4D.ifc in " + dir + " (export_4d target navisworks writes one)."); return 1; }
        var nwd = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.Combine(dir, Path.GetFileNameWithoutExtension(ifc) + ".nwd");
        var app = new NavisworksApplication();
        try
        {
            app.DisableProgress();
            app.AppendFile(ifc);
            var rc = app.ExecuteAddInPlugin("P6Clone4D.WHIQ", dir);
            app.SaveFile(nwd);
            Console.WriteLine("Saved " + nwd);
            return rc is int i ? i : 0;
        }
        finally { app.Dispose(); }
    }
}
